/**
 * Who holds a seat in a workspace right now: the people in it, and the invites
 * holding one for somebody who has not arrived yet.
 *
 * A module of its own, small as it is, because both sides of seat accounting
 * read it — the invite path, which asks whether there is room for another
 * person, and `billing.service`, which asks what a smaller seat count would
 * have to take away from somebody. Keeping it here is what stops those two
 * importing each other.
 *
 * Whether an invite is open is decided by `isInviteOpen` over rows this query
 * has only narrowed, rather than by a `where` clause that repeats the rule. An
 * invite expires against the clock with nothing having to run, so a predicate
 * in SQL would be a second answer to that — and the one that disagrees with the
 * listing the day either is edited. A workspace is bounded by MAX_SEATS, so the
 * expired rows this reads and discards cost nothing worth the second copy.
 */
import { db } from "@/lib/db";
import { isInviteOpen, normaliseInviteEmail, type WorkspaceRoster } from "@/domain/invite";
import { roleFrom, type Role } from "@/domain/role";

/** An invite as the account page lists it. No token to withhold — there is none. */
export interface InviteView {
  id: string;
  email: string;
  invitedByEmail: string;
  expiresAt: Date;
  /** The role the membership will be made with, so the list says what is on offer. */
  role: Role;
}

/** A person in the workspace, as the account page lists them. */
export interface MemberView {
  userId: string;
  email: string;
  role: Role;
}

/**
 * The people in a workspace, with what each of them may do.
 *
 * The role comes back here rather than being read per row where it is needed,
 * because the rules that use it are about the set: whether this person is the
 * last admin is not a question one membership can answer.
 */
export async function membersOf(tenantId: string): Promise<MemberView[]> {
  const rows = await db.membership.findMany({
    where: { tenantId },
    select: { userId: true, role: true, user: { select: { email: true } } },
    orderBy: { createdAt: "asc" },
  });
  // Through `roleFrom` rather than cast: the column is a string, and a value
  // this build does not know narrows to the role that may change nothing.
  return rows.map((row) => ({
    userId: row.userId,
    email: row.user.email,
    role: roleFrom(row.role),
  }));
}

/**
 * The invites still holding a seat in this workspace, oldest first.
 *
 * Accepted and withdrawn rows are dropped in the query because neither can
 * come back; expiry is left to the domain rule above.
 */
export async function openInvitesOf(tenantId: string, now = new Date()): Promise<InviteView[]> {
  const rows = await db.invitation.findMany({
    where: { tenantId, acceptedAt: null, revokedAt: null },
    orderBy: { createdAt: "asc" },
  });
  return rows
    .filter((row) => isInviteOpen(row, now))
    .map((row) => ({
      id: row.id,
      email: row.email,
      invitedByEmail: row.invitedByEmail,
      expiresAt: row.expiresAt,
      role: roleFrom(row.role),
    }));
}

/**
 * The roster the seat rules take: the addresses holding a membership and the
 * addresses an invite is open for.
 *
 * Addresses rather than counts, because the rules ask two things of it — how
 * many seats are taken, and whether this particular address is already one of
 * them — and a count could only answer the first.
 */
export async function rosterFor(tenantId: string, now = new Date()): Promise<WorkspaceRoster> {
  const [members, invites] = await Promise.all([membersOf(tenantId), openInvitesOf(tenantId, now)]);
  return {
    memberEmails: members.map((m) => normaliseInviteEmail(m.email)),
    invitedEmails: invites.map((i) => i.email),
  };
}
