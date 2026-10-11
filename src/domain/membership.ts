/**
 * Who may act for which tenant. Pure — no I/O — so the one rule that decides
 * tenant access is unit-testable and written in exactly one place.
 *
 * A signed-in person is a `User`; the thing that pays and is billed is a
 * `Tenant`. A membership joins them. Requests name a tenant at most as a hint;
 * this function is what turns that hint into an answer.
 *
 * What the caller may then *do* for that tenant is the membership's role, and
 * the rules over it are in ./role. They are separate questions with separate
 * answers, and this file resolves the first one.
 */
import type { Role } from "./role";

export interface Membership {
  tenantId: string;
  role: Role;
}

export interface Principal {
  userId: string;
  memberships: readonly Membership[];
}

export type TenantResolution =
  /** The caller may act for this tenant, in this role. */
  | { ok: true; tenantId: string; role: Role }
  /** Signed in, but belongs to no tenant yet. */
  | { ok: false; reason: "no_tenant" }
  /** Member of several tenants and named none — the caller has to choose. */
  | { ok: false; reason: "ambiguous" }
  /** Named a tenant they are not a member of. */
  | { ok: false; reason: "forbidden" };

export function isMemberOf(principal: Principal, tenantId: string): boolean {
  return principal.memberships.some((m) => m.tenantId === tenantId);
}

/**
 * Resolve the tenant a request acts on.
 *
 * `requested` is caller-supplied and therefore never trusted on its own: it
 * only ever narrows the set of tenants the session already grants. A tenant
 * that does not exist and one the caller is not a member of both come back as
 * `forbidden` — a distinct "no such tenant" would confirm which ids are real.
 *
 * The role rides back with the tenant because this is the function that picks
 * the membership. A caller that resolved the tenant here and then read the
 * role somewhere else would be asking two questions of two rows, and the
 * answer to the second could be a membership this one did not match.
 */
export function resolveTenant(
  principal: Principal,
  requested?: string | null,
): TenantResolution {
  if (requested) {
    const membership = principal.memberships.find((m) => m.tenantId === requested);
    return membership
      ? { ok: true, tenantId: membership.tenantId, role: membership.role }
      : { ok: false, reason: "forbidden" };
  }
  if (principal.memberships.length === 0) return { ok: false, reason: "no_tenant" };
  if (principal.memberships.length > 1) return { ok: false, reason: "ambiguous" };
  const [only] = principal.memberships;
  return { ok: true, tenantId: only.tenantId, role: only.role };
}
