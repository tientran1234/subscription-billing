/**
 * Sending an invite, withdrawing one, accepting one, and removing a member.
 *
 * The seat rules themselves are in src/domain/invite.ts and the roster they
 * read is in ./roster; what is here is the order the writes happen in, which is
 * where the guarantees about a seat being held exactly once live.
 *
 * Acceptance is not a route. The invited address has nothing to click: it signs
 * in the way everybody does, and ./auth's sign-in events call
 * `acceptOpenInvites` with the address that just proved it holds the mailbox.
 * An invite page would be a second way in — one that takes a token, which is
 * the credential this design does not issue.
 */
import { db } from "@/lib/db";
import {
  checkInvite,
  checkMemberRemoval,
  inviteExpiryFrom,
  isInviteOpen,
  normaliseInviteEmail,
  type InviteRefusal,
  type RemovalRefusal,
} from "@/domain/invite";
import { noticeLocaleFor, noticePagesFor } from "@/domain/notice-locale";
import { renderInviteEmail } from "@/emails/render";
import { entitlementsForTenant } from "./billing.service";
import { smtpMailer, type Mailer } from "./mailer";
import { membersOf, openInvitesOf, rosterFor, type InviteView, type MemberView } from "./roster";

export interface InviteMemberInput {
  tenantId: string;
  email: string;
  /** Who is sending it: recorded on the row, and named in the mail. */
  invitedBy: { userId: string; email: string };
  appUrl: string;
  mailer?: Mailer;
}

export type InviteOutcome =
  | InviteRefusal
  /** The row was written and then taken back, because the mail did not go. */
  | "send_failed";

export type InviteResult = { ok: true; invite: InviteView } | { ok: false; reason: InviteOutcome };

/**
 * Offer a seat to an address.
 *
 * The seat count is the derived entitlement rather than the column on the
 * subscription — a workspace whose subscription has ended is back to the one
 * seat its owner holds, and may not invite until it subscribes again.
 *
 * A failed mail takes the row back. The claim-then-release shape is the dunning
 * notice's, for the same reason: a row here is a promise that somebody was
 * told. An invite nobody received would hold a seat for a fortnight on behalf
 * of a person who never heard about it, and the workspace would have no way to
 * tell that from one being thought over — so it is better to have sent nothing
 * and say so.
 */
export async function inviteMember(input: InviteMemberInput): Promise<InviteResult> {
  const email = normaliseInviteEmail(input.email);
  const [roster, entitlements] = await Promise.all([
    rosterFor(input.tenantId),
    entitlementsForTenant(input.tenantId),
  ]);

  const refusal = checkInvite(email, roster, entitlements.seats);
  if (refusal) return { ok: false, reason: refusal };

  const tenant = await db.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) return { ok: false, reason: "no_seat" };

  const invite = await db.invitation.create({
    data: {
      tenantId: input.tenantId,
      email,
      invitedByUserId: input.invitedBy.userId,
      invitedByEmail: input.invitedBy.email,
      expiresAt: inviteExpiryFrom(new Date()),
    },
  });

  // The workspace's own language, which is the only answer there is: the
  // invited address has no row here yet, so nothing is recorded about what it
  // reads. The people already in the workspace chose this one, and an invite
  // from them is more likely to read right in it than in a default.
  const locale = noticeLocaleFor(tenant.locale);
  const message = await renderInviteEmail({
    locale,
    tenantName: tenant.name,
    inviterEmail: input.invitedBy.email,
    // Through the same rule the dunning notices use, so an invite written in
    // one language cannot land on a page in another.
    accountUrl: noticePagesFor(input.appUrl, locale).accountUrl,
  });

  try {
    await (input.mailer ?? smtpMailer()).send({ to: email, ...message });
  } catch {
    await db.invitation.delete({ where: { id: invite.id } });
    return { ok: false, reason: "send_failed" };
  }

  return {
    ok: true,
    invite: {
      id: invite.id,
      email: invite.email,
      invitedByEmail: invite.invitedByEmail,
      expiresAt: invite.expiresAt,
    },
  };
}

/**
 * Withdraw an invite belonging to `tenantId`, releasing the seat it holds.
 *
 * Scoped by update rather than read then write, like revoking an API key: the
 * affected-row count is both the ownership check and the answer, so there is no
 * window in which the row changes hands in between. An invite that is already
 * accepted or withdrawn is not withdrawable — the first is a membership now,
 * and removing a person is the other call below.
 */
export async function revokeInvite(id: string, tenantId: string): Promise<boolean> {
  const { count } = await db.invitation.updateMany({
    where: { id, tenantId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count === 1;
}

/**
 * Turn every invite open for this address into a membership, and report how
 * many that was.
 *
 * Called on sign-in rather than from a link in the mail, which is the whole of
 * the accept flow: the address that signed in has proved it holds the mailbox
 * the invite was sent to, and that is the same proof a token in the mail would
 * have carried — minus the part where the token survives being forwarded.
 *
 * Every open invite, not the first: an address can be invited into more than
 * one workspace, and a sign-in that took one of them would leave the other
 * holding a seat for somebody who is already here and cannot be re-invited.
 *
 * The claim and the membership go in one transaction. The affected-row count on
 * the claim is what makes two sign-ins racing produce one membership, and the
 * transaction is what stops a crash between them leaving an accepted invite
 * with nobody in the workspace — a seat spent on a person who still cannot get
 * in, and no open row left for a later sign-in to pick up.
 */
export async function acceptOpenInvites(user: {
  userId: string;
  email: string;
}): Promise<number> {
  const email = normaliseInviteEmail(user.email);
  const now = new Date();
  const candidates = await db.invitation.findMany({
    where: { email, acceptedAt: null, revokedAt: null },
  });

  let accepted = 0;
  for (const candidate of candidates) {
    if (!isInviteOpen(candidate, now)) continue;

    const won = await db.$transaction(async (tx) => {
      const { count } = await tx.invitation.updateMany({
        where: { id: candidate.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: now, acceptedByUserId: user.userId },
      });
      if (count !== 1) return false;
      // An upsert because the membership is what the invite is for, not a
      // second fact to be surprised by: an address somehow already in the
      // workspace that invited it should end up with one membership rather
      // than an error thrown on its way in from a sign-in.
      await tx.membership.upsert({
        where: { userId_tenantId: { userId: user.userId, tenantId: candidate.tenantId } },
        create: { userId: user.userId, tenantId: candidate.tenantId },
        update: {},
      });
      return true;
    });

    if (won) accepted += 1;
  }

  return accepted;
}

/** Whether an address has a seat waiting for it, before it has an account. */
export async function hasOpenInvite(email: string, now = new Date()): Promise<boolean> {
  const candidates = await db.invitation.findMany({
    where: { email: normaliseInviteEmail(email), acceptedAt: null, revokedAt: null },
  });
  return candidates.some((candidate) => isInviteOpen(candidate, now));
}

export type RemoveMemberResult = { ok: true } | { ok: false; reason: RemovalRefusal };

/**
 * Take somebody out of a workspace, freeing the seat they hold.
 *
 * The membership is the access, so this is the whole of it: entitlements are
 * derived on read, and the session is in Postgres rather than a JWT, so the
 * person is out of the workspace on their very next request rather than
 * whenever a token would have expired.
 *
 * It does not touch the seats the workspace is billed for. The seat is paid for
 * until somebody says otherwise, and buying fewer is a reprice with a
 * proration to quote — which is the plan picker's job, and is exactly the thing
 * the floor stopped them doing while the seat was occupied.
 */
export async function removeMember(tenantId: string, userId: string): Promise<RemoveMemberResult> {
  const members = await membersOf(tenantId);
  const refusal = checkMemberRemoval(
    userId,
    members.map((m) => m.userId),
  );
  if (refusal) return { ok: false, reason: refusal };

  const { count } = await db.membership.deleteMany({ where: { tenantId, userId } });
  // Lost a race with another removal of the same person. Reported as not a
  // member, which is what it is by the time the answer is written.
  if (count !== 1) return { ok: false, reason: "not_a_member" };
  return { ok: true };
}

export interface Roster {
  members: MemberView[];
  invites: InviteView[];
  /** Seats bought, which is what the two lists together may not exceed. */
  seats: number;
}

/** Everything the account page draws for the people in a workspace. */
export async function rosterView(tenantId: string): Promise<Roster> {
  const [members, invites, entitlements] = await Promise.all([
    membersOf(tenantId),
    openInvitesOf(tenantId),
    entitlementsForTenant(tenantId),
  ]);
  return { members, invites, seats: entitlements.seats };
}
