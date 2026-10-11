/**
 * How a second person joins a workspace, and what an invite costs while it
 * waits to be accepted.
 *
 * Pure — no I/O — like the rest of this directory, so the question "is there
 * room for another person here" is answered once and read by the invite form,
 * the route that sends one and the seat change that would sell one back.
 *
 * An invite names an address and carries no token. Sign-in is a magic link, so
 * the mailbox is already the credential: a token in the invite mail would be a
 * second and weaker one for the same thing, and a forwarded mail would hand a
 * seat to somebody the workspace never named. So the invited address signs in
 * the way everybody else does, and an open invite in its name is what turns
 * that sign-in into a membership.
 *
 * An open invite holds the seat it was sent for. That is the rule the rest of
 * this file exists to state, and it is what keeps the two halves of seat
 * accounting from disagreeing: a seat is bought, reserved the moment it is
 * offered to somebody, and accepting it only turns the reservation into a
 * membership. Without the reservation, three invites against one free seat
 * would all be sent and all be accepted, and the workspace would end up
 * holding people it has not paid for — with the floor under a seat reduction,
 * which counts what is taken, reading half the answer.
 *
 * A seat is therefore released by exactly three things: the invite is
 * accepted (and becomes a membership that takes it instead), it is withdrawn,
 * or it expires. The last is why there is an expiry at all — a seat offered to
 * an address that never answers has to come back without anybody remembering
 * to ask for it.
 */
import { isLastAdmin, type RoleHolder } from "./role";

/**
 * How long an invite stays open: long enough for somebody who is away, short
 * enough that the seat behind it is not gone for a quarter. A constant rather
 * than a field beside the address, for the reason the cap's warning threshold
 * is one — a second number to set is a second number to explain, and a
 * workspace that wants longer can send another invite.
 */
export const INVITE_TTL_DAYS = 14;

const DAY_MS = 86_400_000;

export function inviteExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * DAY_MS);
}

/**
 * The address an invite is keyed by.
 *
 * Lower-cased and trimmed because the two ends of an invite are typed by
 * different people: one into an invite form, the other into a sign-in box, and
 * neither of them is copying the row. Only the case is folded — the local part
 * of an address is case-sensitive to the letter of the spec and not one mail
 * provider in use treats it that way, while stripping dots or `+tags` would
 * decide that two addresses a provider keeps apart are the same person, which
 * is a guess about somebody else's mail server.
 */
export function normaliseInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Whether this is an address we are willing to send an invite to.
 *
 * Deliberately conservative rather than exhaustive: one local part, one `@`,
 * and a dotted domain with no spaces anywhere. An address is proved by mail
 * arriving at it and being signed in from, which is the whole of this
 * application's sign-in — so the only job here is to catch the empty box and
 * the obvious typo before a seat is held for something that can never answer.
 */
export function isInvitableEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(normaliseInviteEmail(email));
}

/** Who holds, or is being held, a seat in one workspace. */
export interface WorkspaceRoster {
  /** Addresses that hold a membership: people who can sign in for it today. */
  memberEmails: readonly string[];
  /** Addresses with an invite still open, each holding the seat it was sent for. */
  invitedEmails: readonly string[];
}

export type InviteRefusal =
  /** Empty, or not the shape of an address a mail could reach. */
  | "invalid_email"
  /** Already holds a membership, so there is nothing to offer. */
  | "already_member"
  /** Already has an invite open, which is already holding a seat. */
  | "already_invited"
  /** Every seat the workspace has bought is taken or held. */
  | "no_seat";

/**
 * Seats taken right now: the people in the workspace plus the invites holding
 * one for somebody.
 *
 * This is the figure both seat rules read. The ceiling asks whether it is below
 * the seats bought before offering another one; the floor under a reduction
 * asks what a smaller count would have to take away from somebody. They have to
 * be the same number, or a workspace can sell back a seat it has promised.
 */
export function seatsTaken(roster: WorkspaceRoster): number {
  return roster.memberEmails.length + roster.invitedEmails.length;
}

/**
 * Whether `email` may be invited into a workspace with this roster and `seats`
 * bought. `null` means it may.
 *
 * `seats` is the derived entitlement rather than the column on the
 * subscription, so a workspace whose subscription has ended is back to the one
 * seat its owner holds and cannot invite until it subscribes again. The people
 * already in it keep their memberships: entitlements are the workspace's and
 * end with the subscription, but a membership is a person, and dropping one on
 * a failed renewal would take somebody's access away to make a count tidy.
 */
export function checkInvite(
  email: string,
  roster: WorkspaceRoster,
  seats: number,
): InviteRefusal | null {
  if (!isInvitableEmail(email)) return "invalid_email";

  const address = normaliseInviteEmail(email);
  // Both before the seat check, so an address that is already in the workspace
  // is told so rather than being told the workspace is full — which is the
  // answer to a different question and sends somebody to buy a seat they do
  // not need.
  if (roster.memberEmails.some((m) => normaliseInviteEmail(m) === address)) {
    return "already_member";
  }
  if (roster.invitedEmails.some((i) => normaliseInviteEmail(i) === address)) {
    return "already_invited";
  }

  return seatsTaken(roster) >= seats ? "no_seat" : null;
}

/** An invite row, as far as the question "is this one still open" needs it. */
export interface InviteWindow {
  expiresAt: Date;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
}

/**
 * Is this invite still open — still holding its seat, and still able to turn a
 * sign-in into a membership?
 *
 * Expiry is read against the clock rather than written into the row by
 * something that sweeps, so a seat comes back on time whether or not anything
 * ran. The three conditions are one function because the roster, the accept
 * path and the listing all have to agree about it: an invite the listing draws
 * as open but the accept path refuses is a seat nobody can use and nobody can
 * get back.
 */
export function isInviteOpen(invite: InviteWindow, now: Date): boolean {
  if (invite.acceptedAt || invite.revokedAt) return false;
  return invite.expiresAt.getTime() > now.getTime();
}

export type RemovalRefusal =
  /** Not in this workspace, so there is nothing to remove. */
  | "not_a_member"
  /** The only member left: a workspace nobody can sign in to is unreachable. */
  | "last_member"
  /** The only admin left: a workspace nobody can change is unmanageable. */
  | "last_admin";

/**
 * Whether the member `userId` may be removed from a workspace whose
 * memberships are `members`. `null` means they may.
 *
 * The last member is refused because the subscription outlives the memberships
 * — the workspace would go on being billed with nobody able to sign in, cancel
 * it or even read the invoices, and no invite could be sent to fix it because
 * sending one takes a member. Removing yourself is otherwise allowed: somebody
 * who was invited into a workspace they no longer work with should not have to
 * ask the people still in it to let them out.
 *
 * The last admin is refused one step in from that, for the reason spelled out
 * at `isLastAdmin`: a workspace left with only members can still be signed in
 * to and read, and still cannot be cancelled, repriced or re-staffed by
 * anybody in it. Whoever is leaving promotes somebody first, which is the
 * handover this refusal exists to make them do.
 *
 * Who is *allowed* to ask for a removal is `canRemoveMember`, not this. This
 * answers whether the workspace survives it, which is true or false whoever
 * is asking.
 */
export function checkMemberRemoval(
  userId: string,
  members: readonly RoleHolder[],
): RemovalRefusal | null {
  if (!members.some((member) => member.userId === userId)) return "not_a_member";
  // Before the admin check, because a sole member who is also the sole admin
  // is both, and being told the workspace would have nobody in it is the more
  // useful half of that: promoting somebody is not a way out of it.
  if (members.length <= 1) return "last_member";
  return isLastAdmin(userId, members) ? "last_admin" : null;
}
