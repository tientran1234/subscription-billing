/**
 * Who may act for which tenant. Pure — no I/O — so the one rule that decides
 * tenant access is unit-testable and written in exactly one place.
 *
 * A signed-in person is a `User`; the thing that pays and is billed is a
 * `Tenant`. A membership joins them. Requests name a tenant at most as a hint;
 * this function is what turns that hint into an answer.
 */

export interface Membership {
  tenantId: string;
}

export interface Principal {
  userId: string;
  memberships: readonly Membership[];
}

export type TenantResolution =
  /** The caller may act for this tenant. */
  | { ok: true; tenantId: string }
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
 */
export function resolveTenant(
  principal: Principal,
  requested?: string | null,
): TenantResolution {
  if (requested) {
    return isMemberOf(principal, requested)
      ? { ok: true, tenantId: requested }
      : { ok: false, reason: "forbidden" };
  }
  if (principal.memberships.length === 0) return { ok: false, reason: "no_tenant" };
  if (principal.memberships.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, tenantId: principal.memberships[0].tenantId };
}
