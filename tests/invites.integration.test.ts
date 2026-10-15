/**
 * Runs against a real Postgres, because the guarantees being tested are
 * database guarantees: the conditional UPDATE that claims an invite, the
 * transaction that pairs it with the membership, and the seat count that two
 * rules read off the same rows. Mocking the database would test the mock.
 *
 *   pnpm db:up && pnpm db:push && pnpm test
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { INVITE_TTL_DAYS } from "@/domain/invite";
import {
  acceptOpenInvites,
  hasOpenInvite,
  inviteMember,
  removeMember,
  revokeInvite,
  rosterView,
  setMemberRole,
} from "@/server/invites";
import type { Role } from "@/domain/role";
import { previewPlanChange } from "@/server/billing.service";
import { MemoryMailer } from "@/server/mailer";
import { FakeProvider } from "@/providers/fake";

const hasDatabase = Boolean(process.env.DATABASE_URL);

const APP_URL = "https://billing.example.test";

describe.skipIf(!hasDatabase)("invites", () => {
  let tenantId: string;
  let ownerId: string;
  let ownerEmail: string;
  let mailer: MemoryMailer;

  /** The address that set the workspace up, which holds the first seat. */
  const owner = () => ({ userId: ownerId, email: ownerEmail });

  const invite = (email: string, role: Role = "member") =>
    inviteMember({ tenantId, email, role, invitedBy: owner(), appUrl: APP_URL, mailer });

  /** A person with an account, the way an already-registered invitee is. */
  const signedUp = async (email: string) => {
    const user = await db.user.create({ data: { email } });
    return { userId: user.id, email };
  };

  /** Seats bought, which is what the roster may not exceed. */
  const sell = (seats: number) =>
    db.subscription.create({
      data: { tenantId, planKey: "pro", status: "ACTIVE", seats, providerRef: `sub_${randomUUID()}` },
    });

  beforeEach(async () => {
    await db.tenant.deleteMany();
    await db.user.deleteMany();
    mailer = new MemoryMailer();

    ownerEmail = `owner-${randomUUID()}@example.test`;
    const tenant = await db.tenant.create({ data: { email: ownerEmail, name: "Acme" } });
    tenantId = tenant.id;
    const user = await db.user.create({ data: { email: ownerEmail } });
    ownerId = user.id;
    await db.membership.create({ data: { userId: ownerId, tenantId } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("offers a seat to an address and writes to it", async () => {
    await sell(3);
    const result = await invite("new@example.test");

    expect(result.ok).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("new@example.test");
    // The mail points at the account page and carries no token to forward.
    expect(mailer.sent[0].html).toContain(`${APP_URL}/en/account`);
  });

  it("holds the seat while the invite is open, so it cannot be offered twice", async () => {
    await sell(2);
    expect((await invite("first@example.test")).ok).toBe(true);

    // Two seats, one owner, one invite out: there is nothing left to offer.
    const second = await invite("second@example.test");
    expect(second).toEqual({ ok: false, reason: "no_seat" });
    expect(mailer.sent).toHaveLength(1);
  });

  it("gives the seat back when the invite is withdrawn", async () => {
    await sell(2);
    const first = await invite("first@example.test");
    if (!first.ok) throw new Error("expected the first invite to be sent");

    expect(await revokeInvite(first.invite.id, tenantId)).toBe(true);
    expect((await invite("second@example.test")).ok).toBe(true);
  });

  it("refuses to withdraw an invite belonging to another workspace", async () => {
    await sell(2);
    const sent = await invite("first@example.test");
    if (!sent.ok) throw new Error("expected the invite to be sent");

    const other = await db.tenant.create({
      data: { email: `other-${randomUUID()}@example.test`, name: "Other" },
    });
    expect(await revokeInvite(sent.invite.id, other.id)).toBe(false);
    // Still holding its seat, which is the point of the refusal.
    expect((await rosterView(tenantId)).invites).toHaveLength(1);
  });

  it("gives the seat back once the invite has expired", async () => {
    await sell(2);
    const sent = await invite("late@example.test");
    if (!sent.ok) throw new Error("expected the invite to be sent");

    // Expiry is read against the clock, so nothing has to run for the seat to
    // come back — the row is simply no longer open.
    await db.invitation.update({
      where: { id: sent.invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await rosterView(tenantId)).invites).toHaveLength(0);
    expect(await hasOpenInvite("late@example.test")).toBe(false);
    expect((await invite("other@example.test")).ok).toBe(true);
  });

  it("turns an open invite into a membership when that address signs in", async () => {
    await sell(3);
    await invite("joiner@example.test");
    const joiner = await signedUp("joiner@example.test");

    expect(await acceptOpenInvites(joiner)).toBe(1);

    const roster = await rosterView(tenantId);
    expect(roster.members.map((m) => m.email).sort()).toEqual(
      [ownerEmail, "joiner@example.test"].sort(),
    );
    // The seat it was holding is now held by the membership instead, so the
    // figure the seat rules read has not moved.
    expect(roster.invites).toHaveLength(0);
  });

  it("matches the invited address to a sign-in whatever case either used", async () => {
    await sell(3);
    await invite("Mixed.Case@Example.TEST");
    const joiner = await signedUp("mixed.case@example.test");

    expect(await acceptOpenInvites(joiner)).toBe(1);
    expect((await rosterView(tenantId)).members).toHaveLength(2);
  });

  it("accepts once, however many times the sign-in is replayed", async () => {
    await sell(3);
    await invite("joiner@example.test");
    const joiner = await signedUp("joiner@example.test");

    expect(await acceptOpenInvites(joiner)).toBe(1);
    // The claim is the conditional UPDATE, so a second sign-in finds no open
    // row and makes no second membership.
    expect(await acceptOpenInvites(joiner)).toBe(0);
    expect((await rosterView(tenantId)).members).toHaveLength(2);
  });

  it("takes every workspace that invited one address, not just the first", async () => {
    await sell(3);
    await invite("joiner@example.test");

    const second = await db.tenant.create({
      data: { email: `second-${randomUUID()}@example.test`, name: "Second" },
    });
    await db.subscription.create({
      data: { tenantId: second.id, planKey: "pro", status: "ACTIVE", seats: 2 },
    });
    const secondOwner = await signedUp(`owner2-${randomUUID()}@example.test`);
    await db.membership.create({ data: { userId: secondOwner.userId, tenantId: second.id } });
    await inviteMember({
      tenantId: second.id,
      email: "joiner@example.test",
      role: "member",
      invitedBy: secondOwner,
      appUrl: APP_URL,
      mailer,
    });

    const joiner = await signedUp("joiner@example.test");
    // Taking one and leaving the other would strand a seat: the address is a
    // member now, so that invite could never be accepted or re-sent.
    expect(await acceptOpenInvites(joiner)).toBe(2);
  });

  it("does not accept an invite that was withdrawn before the sign-in", async () => {
    await sell(3);
    const sent = await invite("joiner@example.test");
    if (!sent.ok) throw new Error("expected the invite to be sent");
    await revokeInvite(sent.invite.id, tenantId);

    const joiner = await signedUp("joiner@example.test");
    expect(await acceptOpenInvites(joiner)).toBe(0);
    expect((await rosterView(tenantId)).members).toHaveLength(1);
  });

  it("refuses an address that is already in the workspace", async () => {
    await sell(3);
    expect(await invite(ownerEmail)).toEqual({ ok: false, reason: "already_member" });
    expect(mailer.sent).toHaveLength(0);
  });

  it("refuses a second invite to an address that already has one open", async () => {
    await sell(3);
    await invite("joiner@example.test");
    expect(await invite("joiner@example.test")).toEqual({
      ok: false,
      reason: "already_invited",
    });
    expect(mailer.sent).toHaveLength(1);
  });

  it("takes the row back when the mail does not go, so no seat is held", async () => {
    await sell(3);
    const broken = {
      async send() {
        throw new Error("smtp is down");
      },
    };

    const result = await inviteMember({
      tenantId,
      email: "unreachable@example.test",
      role: "member",
      invitedBy: owner(),
      appUrl: APP_URL,
      mailer: broken,
    });

    expect(result).toEqual({ ok: false, reason: "send_failed" });
    // A row here is a promise that somebody was told. Nobody was, so a seat
    // held for a fortnight on their behalf would be a seat lost to nothing.
    expect((await rosterView(tenantId)).invites).toHaveLength(0);
    expect(await hasOpenInvite("unreachable@example.test")).toBe(false);
  });

  it("will not invite past the seats a workspace has bought", async () => {
    await sell(1);
    expect(await invite("nobody@example.test")).toEqual({ ok: false, reason: "no_seat" });
  });

  it("will not invite from a workspace whose subscription has ended", async () => {
    // Seats are a derived entitlement: a cancelled workspace is back to the one
    // its owner holds, whatever the column on the dead row still says.
    await db.subscription.create({
      data: { tenantId, planKey: "pro", status: "CANCELED", seats: 5 },
    });
    expect(await invite("nobody@example.test")).toEqual({ ok: false, reason: "no_seat" });
  });

  it("holds an open invite against a seat reduction, as a member would be", async () => {
    await sell(3);
    await invite("joiner@example.test");

    // Two seats taken — the owner and the invite — so a drop to one is refused
    // by the same floor that protects a person. Without the invite in the
    // count, the workspace could sell back the seat it has just promised.
    const refused = await previewPlanChange(new FakeProvider(), {
      tenantId,
      planKey: "pro",
      priceRef: "price_pro",
      seats: 1,
    });
    expect(refused).toEqual({ ok: false, reason: "seats_in_use" });
  });

  it("makes the membership with the role the seat was offered in", async () => {
    await sell(4);
    const asMember = await invite("reader@example.test");
    const asAdmin = await invite("second-admin@example.test", "admin");
    if (!asMember.ok || !asAdmin.ok) throw new Error("expected both invites to be sent");

    await acceptOpenInvites(await signedUp("reader@example.test"));
    await acceptOpenInvites(await signedUp("second-admin@example.test"));

    // What was offered is what arrives: an address accepting a seat must not
    // land with powers nobody decided to give it.
    const roles = new Map(
      (await rosterView(tenantId)).members.map((m) => [m.email, m.role] as const),
    );
    expect(roles.get("reader@example.test")).toBe("member");
    expect(roles.get("second-admin@example.test")).toBe("admin");
  });

  it("expires an invite a fortnight out, which is the seat it holds coming back", async () => {
    await sell(3);
    const sent = await invite("joiner@example.test");
    if (!sent.ok) throw new Error("expected the invite to be sent");

    const days = (sent.invite.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(INVITE_TTL_DAYS);
  });
});

describe.skipIf(!hasDatabase)("removing a member", () => {
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    await db.tenant.deleteMany();
    await db.user.deleteMany();
    const email = `owner-${randomUUID()}@example.test`;
    tenantId = (await db.tenant.create({ data: { email, name: "Acme" } })).id;
    ownerId = (await db.user.create({ data: { email } })).id;
    await db.membership.create({ data: { userId: ownerId, tenantId } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const join = async () => {
    const user = await db.user.create({
      data: { email: `member-${randomUUID()}@example.test` },
    });
    await db.membership.create({ data: { userId: user.id, tenantId } });
    return user.id;
  };

  it("frees the seat a member was holding", async () => {
    const second = await join();
    expect(await removeMember(tenantId, second)).toEqual({ ok: true });
    expect((await rosterView(tenantId)).members).toHaveLength(1);
  });

  it("refuses the last member, who is the only way back into the workspace", async () => {
    // The subscription outlives the membership: a workspace with nobody in it
    // goes on being billed with no one able to sign in and cancel it.
    expect(await removeMember(tenantId, ownerId)).toEqual({ ok: false, reason: "last_member" });
    expect((await rosterView(tenantId)).members).toHaveLength(1);
  });

  it("refuses somebody who is not in this workspace", async () => {
    const other = await db.user.create({
      data: { email: `stranger-${randomUUID()}@example.test` },
    });
    expect(await removeMember(tenantId, other.id)).toEqual({
      ok: false,
      reason: "not_a_member",
    });
  });

  it("does not touch the seats the workspace is billed for", async () => {
    await db.subscription.create({
      data: { tenantId, planKey: "pro", status: "ACTIVE", seats: 4 },
    });
    const second = await join();
    await removeMember(tenantId, second);

    // The seat is paid for until somebody reprices it, which is the plan
    // picker's job — and the thing the floor was stopping while it was taken.
    expect((await rosterView(tenantId)).seats).toBe(4);
  });
});

describe.skipIf(!hasDatabase)("setting what a member may do", () => {
  let tenantId: string;
  let ownerId: string;
  let ownerEmail: string;

  /** The workspace's admin, who is the one making every change below. */
  const owner = () => ({ userId: ownerId, email: ownerEmail });

  beforeEach(async () => {
    await db.tenant.deleteMany();
    await db.user.deleteMany();
    const email = `owner-${randomUUID()}@example.test`;
    ownerEmail = email;
    tenantId = (await db.tenant.create({ data: { email, name: "Acme" } })).id;
    ownerId = (await db.user.create({ data: { email } })).id;
    await db.membership.create({ data: { userId: ownerId, tenantId, role: "admin" } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const join = async (role: Role) => {
    const user = await db.user.create({
      data: { email: `member-${randomUUID()}@example.test` },
    });
    await db.membership.create({ data: { userId: user.id, tenantId, role } });
    return user.id;
  };

  const roleOf = async (userId: string) =>
    (await rosterView(tenantId)).members.find((m) => m.userId === userId)?.role;

  it("promotes a member, and demotes them again once there is another admin", async () => {
    const second = await join("member");
    expect(await setMemberRole(tenantId, second, "admin", owner())).toEqual({ ok: true });
    expect(await roleOf(second)).toBe("admin");

    expect(await setMemberRole(tenantId, second, "member", owner())).toEqual({ ok: true });
    expect(await roleOf(second)).toBe("member");
  });

  it("refuses to demote the last admin, and leaves the row alone", async () => {
    await join("member");
    expect(await setMemberRole(tenantId, ownerId, "member", owner())).toEqual({
      ok: false,
      reason: "last_admin",
    });
    // The refusal has to be the whole of it: a workspace of members goes on
    // being billed with nobody in it able to cancel or reprice it.
    expect(await roleOf(ownerId)).toBe("admin");
  });

  it("lets the last admin hand the role over and then step down", async () => {
    const second = await join("member");
    expect(await setMemberRole(tenantId, second, "admin", owner())).toEqual({ ok: true });
    expect(await setMemberRole(tenantId, ownerId, "member", owner())).toEqual({ ok: true });
    expect(await roleOf(ownerId)).toBe("member");
  });

  it("refuses the last admin's removal for the same reason as their demotion", async () => {
    await join("member");
    expect(await removeMember(tenantId, ownerId)).toEqual({ ok: false, reason: "last_admin" });
    expect((await rosterView(tenantId)).members).toHaveLength(2);
  });

  it("refuses somebody who is not in this workspace", async () => {
    const stranger = await db.user.create({
      data: { email: `stranger-${randomUUID()}@example.test` },
    });
    expect(await setMemberRole(tenantId, stranger.id, "admin", owner())).toEqual({
      ok: false,
      reason: "not_a_member",
    });
  });

  it("is a no-op, not a refusal, when the role is already the one asked for", async () => {
    expect(await setMemberRole(tenantId, ownerId, "admin", owner())).toEqual({ ok: true });
    expect(await roleOf(ownerId)).toBe("admin");
  });
});
