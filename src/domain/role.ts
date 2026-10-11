/**
 * What each person in a workspace may do, as opposed to which workspace they
 * may act for.
 *
 * Pure — no I/O — like the rest of this directory, so the one rule that
 * decides whether a change is allowed is written in exactly one place and read
 * by the route wrapper that refuses it, the account page that withholds the
 * button, and the membership writes that may not leave a workspace with nobody
 * able to administer it.
 *
 * Kept apart from `membership.ts` because the two questions fail differently.
 * A caller outside a workspace is told nothing about it at all — not even that
 * the id is real. A member without the power to make a change can already see
 * everything the change would affect: the bill they share, the people they
 * share it with, the seats being paid for. They are simply refused, and told
 * why.
 */

/**
 * An admin may change the workspace; a member may read it.
 *
 * Two roles rather than a ladder of them, because the things a workspace can
 * have done to it are all the same size: changing the plan, moving the cap,
 * minting a credential and removing a person are each enough to cost the
 * people sharing the bill money or access. Splitting those across three roles
 * would be a promise that one of them is the safe one to hand out.
 */
export type Role = "admin" | "member";

/** Both roles, for the places that offer a choice between them. */
export const ROLES = ["admin", "member"] as const;

/**
 * Read a role off a row or a request.
 *
 * Fails closed: anything this build does not recognise — a role written by a
 * newer deploy, a column edited by hand, a string off a request body — is read
 * as `member`, which may change nothing. Widening an unknown value to `admin`
 * instead would make a typo a way to hand out every power a workspace has.
 */
export function roleFrom(value: unknown): Role {
  return value === "admin" ? "admin" : "member";
}

/**
 * Whether this role may change anything about the workspace: its plan and
 * seats, the ceiling on its metered add-on, the language it is written to in,
 * its machine credentials, a gateway event replayed through it, and who else
 * is in it.
 *
 * One predicate rather than a matrix of roles against actions. The division is
 * whole — an admin may make every change here and a member may make none — so
 * a matrix would be a table whose every row read the same, and the second
 * answer to go stale the day one row stopped matching. Reading is in neither:
 * everybody in a workspace may read the bill they are sharing, which is most
 * of what the account page is.
 */
export function canChangeWorkspace(role: Role): boolean {
  return role === "admin";
}

/** A member, as far as the rules below need them. */
export interface RoleHolder {
  userId: string;
  role: Role;
}

/**
 * Whether `actor` may take `subjectUserId` out of the workspace.
 *
 * Leaving is not an administrative act. Somebody invited into a workspace they
 * no longer work with should not have to ask the people still in it to let
 * them out — that was true before roles existed, and it is not a power a role
 * should be able to take away. Taking somebody *else* out is administrative,
 * and needs the role for it.
 */
export function canRemoveMember(actor: RoleHolder, subjectUserId: string): boolean {
  return actor.userId === subjectUserId || canChangeWorkspace(actor.role);
}

/**
 * Whether `userId` is the only admin this workspace has left.
 *
 * The rule two callers share: a demotion and a removal both end with one fewer
 * admin, and the workspace that has none is the same wreck either way. The
 * subscription outlives the memberships, so it would go on being billed with
 * nobody able to change the plan, cancel it through the portal, move the cap
 * or promote anybody — and no invite could fix it from outside, because
 * sending one takes an admin. That is the `last_member` harm one step in, and
 * it is refused for the same reason.
 */
export function isLastAdmin(userId: string, members: readonly RoleHolder[]): boolean {
  const admins = members.filter((member) => member.role === "admin");
  return admins.length === 1 && admins[0].userId === userId;
}

export type RoleChangeRefusal =
  /** Not in this workspace, so there is no role here to set. */
  | "not_a_member"
  /** The only admin left: the workspace would have nobody able to change it. */
  | "last_admin";

/**
 * Whether `userId`'s role in this workspace may be set to `role`. `null` means
 * it may.
 *
 * Setting the role somebody already has is allowed rather than refused as a
 * demotion. It changes nothing, and the alternative is a button that reports
 * `last_admin` to the sole admin who clicked "make admin" on their own row.
 */
export function checkRoleChange(
  userId: string,
  role: Role,
  members: readonly RoleHolder[],
): RoleChangeRefusal | null {
  const subject = members.find((member) => member.userId === userId);
  if (!subject) return "not_a_member";
  if (subject.role === role) return null;
  return role === "member" && isLastAdmin(userId, members) ? "last_admin" : null;
}
