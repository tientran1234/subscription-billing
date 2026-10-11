/**
 * The workspaces an account may act for, by name.
 *
 * The session already carries which tenants those are and what the account may
 * do in each — that is what a `Principal` is — so the only thing this adds is
 * the name somebody choosing between two of them has to read: `cl7f3a…` is not
 * a thing anybody can pick. The ids come from the memberships and never from a
 * request, so this read cannot widen what the session granted; it can only put
 * a label on it.
 */
import { db } from "@/lib/db";
import type { Membership, Principal } from "@/domain/membership";

/** A workspace as a picker lists it: the membership, plus what it is called. */
export interface WorkspaceChoice extends Membership {
  name: string;
}

/**
 * Name every workspace this account holds a membership in, in the order the
 * memberships came back.
 *
 * A membership whose tenant row has gone is left out rather than listed under
 * its id. Memberships cascade with the tenant, so that can only be a workspace
 * deleted after this session read its memberships — and offering a choice that
 * resolves to nothing would be worse than one fewer row.
 */
export async function workspacesFor(principal: Principal): Promise<WorkspaceChoice[]> {
  if (principal.memberships.length === 0) return [];
  const tenants = await db.tenant.findMany({
    where: { id: { in: principal.memberships.map((m) => m.tenantId) } },
    select: { id: true, name: true },
  });
  const names = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
  return principal.memberships.flatMap((membership) => {
    const name = names.get(membership.tenantId);
    return name === undefined ? [] : [{ ...membership, name }];
  });
}
