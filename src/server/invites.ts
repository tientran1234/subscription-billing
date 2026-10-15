/**
 * Sending an invite, withdrawing one, accepting one, removing a member, and
 * setting what one of them may do.
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
import { checkRoleChange, roleFrom, type Role, type RoleChangeRefusal } from "@/domain/role";
import { renderInviteEmail } from "@/emails/render";
import { entitlementsForTenant } from "./billing.service";
import { smtpMailer, type Mailer } from "./mailer";
import { recordRoleGrant } from "./role-history";
import { membersOf, openInvitesOf, rosterFor, type InviteView, type MemberView } from "./roster";

export interface InviteMemberInput {
  tenantId: string;
  email: string;
  /** What the seat will carry when it is accepted. */
  role: Role;
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
      role: input.role,
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
      role: input.role,
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
      // Read before the upsert because the two cases below record different
      // things, and afterwards there is no telling them apart.
      const held = await tx.membership.findUnique({
        where: { userId_tenantId: { userId: user.userId, tenantId: candidate.tenantId } },
        select: { role: true },
      });
      // An upsert because the membership is what the invite is for, not a
      // second fact to be surprised by: an address somehow already in the
      // workspace that invited it should end up with one membership rather
      // than an error thrown on its way in from a sign-in.
      // The role the invite was sent with, so what arrives is what was
      // offered. `update: {}` on the already-there case for the same reason it
      // is empty for everything else: a membership that somehow exists already
      // has a role somebody set, and an invite is not the place to overwrite
      // it.
      await tx.membership.upsert({
        where: { userId_tenantId: { userId: user.userId, tenantId: candidate.tenantId } },
        create: {
          userId: user.userId,
          tenantId: candidate.tenantId,
          role: roleFrom(candidate.role),
        },
        update: {},
      });
      // In the same transaction as the membership, so a workspace cannot end
      // up with somebody holding a role nobody is recorded as giving them.
      // Only the membership this accept created is a grant: the already-there
      // case left the role somebody else set alone, so nothing was handed over
      // here to write down — whoever did it is already further up this list.
      if (!held) {
        await recordRoleGrant(tx, {
          tenantId: candidate.tenantId,
          subject: { userId: user.userId, email: user.email },
          // The invite's own columns: the seat was offered by whoever sent it,
          // and it is their grant even though the sign-in is what completes it.
          grantedBy: { userId: candidate.invitedByUserId, email: candidate.invitedByEmail },
          role: roleFrom(candidate.role),
          previousRole: null,
        });
      }
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
  const refusal = checkMemberRemoval(userId, members);
  if (refusal) return { ok: false, reason: refusal };

  const { count } = await db.membership.deleteMany({ where: { tenantId, userId } });
  // Lost a race with another removal of the same person. Reported as not a
  // member, which is what it is by the time the answer is written.
  if (count !== 1) return { ok: false, reason: "not_a_member" };
  return { ok: true };
}

export type SetRoleResult = { ok: true } | { ok: false; reason: RoleChangeRefusal };

/**
 * A transaction Postgres refused to serialise, which is how the isolation
 * level below reports a conflict rather than by making one caller wait.
 * Matched on the code so this file does not depend on which of the client's
 * error constructors a given build threw.
 */
function isSerialisationFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "P2034" || code === "40001";
}

/**
 * Set what somebody in this workspace may do.
 *
 * The one write here that cannot be a scoped `UPDATE` whose affected-row count
 * is the answer, the way withdrawing an invite is. What makes a demotion
 * allowed is a fact about the *other* memberships — that one of them is still
 * an admin — and no `WHERE` clause on the row being changed can see that. Two
 * admins demoting each other at the same moment would each read an admin
 * beside them, each pass the check, and leave a workspace with none: billed,
 * signed in to, readable, and impossible for anybody in it to cancel or
 * re-staff. That is the wreck `isLastAdmin` exists to prevent, so it is worth
 * the serialisable read.
 *
 * Postgres answers that race by refusing to serialise one of the two rather
 * than by queueing it, which is why there is a second attempt: it re-reads,
 * finds the admin the other demotion left behind, and refuses properly instead
 * of handing the caller a failed write to interpret. Only one retry — a second
 * conflict is not this race.
 */
export async function setMemberRole(
  tenantId: string,
  userId: string,
  role: Role,
  grantedBy: { userId: string; email: string },
): Promise<SetRoleResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx): Promise<SetRoleResult> => {
          const rows = await tx.membership.findMany({
            where: { tenantId },
            // The address comes back for the grant below, which records it as
            // it reads now rather than as a row to join to later.
            select: { userId: true, role: true, user: { select: { email: true } } },
          });
          const members = rows.map((row) => ({
            userId: row.userId,
            role: roleFrom(row.role),
          }));

          const refusal = checkRoleChange(userId, role, members);
          if (refusal) return { ok: false, reason: refusal };

          await tx.membership.update({
            where: { userId_tenantId: { userId, tenantId } },
            data: { role },
          });
          // In the same transaction as the column, so the history cannot
          // disagree with the role it describes — and inside the retry, so a
          // transaction Postgres refused to serialise takes its grant back
          // with it rather than leaving one for a change that never landed.
          // `checkRoleChange` has already refused the user who is not in this
          // workspace, so this narrows the row rather than deciding anything:
          // the rule above stays the only place that says who may be set.
          const subject = rows.find((row) => row.userId === userId);
          if (subject) {
            await recordRoleGrant(tx, {
              tenantId,
              subject: { userId, email: subject.user.email },
              grantedBy,
              role,
              previousRole: roleFrom(subject.role),
            });
          }
          return { ok: true };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (err) {
      if (attempt > 0 || !isSerialisationFailure(err)) throw err;
    }
  }
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
