import { describe, expect, it } from "vitest";
import {
  INVITE_TTL_DAYS,
  checkInvite,
  checkMemberRemoval,
  inviteExpiryFrom,
  isInvitableEmail,
  isInviteOpen,
  normaliseInviteEmail,
  seatsTaken,
  type WorkspaceRoster,
} from "@/domain/invite";

const roster = (members: string[], invited: string[] = []): WorkspaceRoster => ({
  memberEmails: members,
  invitedEmails: invited,
});

const now = new Date("2026-10-11T00:00:00.000Z");
const open = { expiresAt: new Date("2026-10-20T00:00:00.000Z") };

describe("an address a workspace may invite", () => {
  it("invites into a spare seat", () => {
    expect(checkInvite("new@example.test", roster(["owner@example.test"]), 3)).toBeNull();
  });

  it("refuses an address that is already a member", () => {
    expect(checkInvite("owner@example.test", roster(["owner@example.test"]), 5)).toBe(
      "already_member",
    );
  });

  it("refuses an address that already has an invite open", () => {
    expect(
      checkInvite("pending@example.test", roster(["owner@example.test"], ["pending@example.test"]), 5),
    ).toBe("already_invited");
  });

  it("matches a member or an invite whatever case either was typed in", () => {
    // The two ends are typed by different people, into different boxes.
    expect(checkInvite("Owner@Example.TEST", roster(["owner@example.test"]), 5)).toBe(
      "already_member",
    );
    expect(checkInvite(" pending@example.test ", roster([], ["PENDING@example.test"]), 5)).toBe(
      "already_invited",
    );
  });

  it("says the address is already here rather than that the workspace is full", () => {
    // Both are true of a full workspace being asked to re-invite one of its
    // own. Reporting "no_seat" would send somebody to buy a seat for a person
    // who already has one.
    expect(checkInvite("owner@example.test", roster(["owner@example.test"]), 1)).toBe(
      "already_member",
    );
  });

  it("refuses what is not the shape of an address", () => {
    for (const bad of ["", "   ", "nobody", "no@domain", "two@@at.test", "sp ace@a.test"]) {
      expect(checkInvite(bad, roster([]), 5)).toBe("invalid_email");
    }
    expect(isInvitableEmail("someone+tag@mail.example.test")).toBe(true);
  });
});

describe("the seat an open invite holds", () => {
  it("counts an open invite against the seats bought", () => {
    // Two seats, one member, one invite out: the second seat is promised.
    expect(checkInvite("third@example.test", roster(["a@example.test"], ["b@example.test"]), 2)).toBe(
      "no_seat",
    );
  });

  it("stops two invites filling the same last seat", () => {
    // This is the guarantee. Without the invite in the count, both of these
    // are sent against one free seat and both are accepted.
    const before = roster(["a@example.test"]);
    expect(checkInvite("b@example.test", before, 2)).toBeNull();
    const after = roster(["a@example.test"], ["b@example.test"]);
    expect(checkInvite("c@example.test", after, 2)).toBe("no_seat");
  });

  it("counts members and open invites as one figure, which both seat rules read", () => {
    expect(seatsTaken(roster(["a@example.test", "b@example.test"]))).toBe(2);
    expect(seatsTaken(roster(["a@example.test"], ["b@example.test", "c@example.test"]))).toBe(3);
    expect(seatsTaken(roster([]))).toBe(0);
  });

  it("refuses an invite from a workspace whose seats are all held by people", () => {
    expect(checkInvite("new@example.test", roster(["a@example.test"]), 1)).toBe("no_seat");
  });

  it("frees the seat again once the invite is no longer open", () => {
    // A withdrawn or expired invite is not in `invitedEmails` — the roster is
    // built from the open ones — so the seat is offerable again.
    expect(checkInvite("c@example.test", roster(["a@example.test"]), 2)).toBeNull();
  });
});

describe("whether an invite is still open", () => {
  it("is open until it expires", () => {
    expect(isInviteOpen(open, now)).toBe(true);
  });

  it("closes on expiry, with nothing having to run", () => {
    expect(isInviteOpen({ expiresAt: new Date("2026-10-10T23:59:59.000Z") }, now)).toBe(false);
    // The boundary is not open: an invite expiring exactly now is expired.
    expect(isInviteOpen({ expiresAt: now }, now)).toBe(false);
  });

  it("closes once accepted, so the seat is held by the membership instead", () => {
    expect(isInviteOpen({ ...open, acceptedAt: now }, now)).toBe(false);
  });

  it("closes once withdrawn", () => {
    expect(isInviteOpen({ ...open, revokedAt: now }, now)).toBe(false);
  });

  it("expires an invite a fortnight after it was sent", () => {
    const expiry = inviteExpiryFrom(now);
    expect(isInviteOpen({ expiresAt: expiry }, now)).toBe(true);
    const aDayLate = new Date(now.getTime() + (INVITE_TTL_DAYS + 1) * 86_400_000);
    expect(isInviteOpen({ expiresAt: expiry }, aDayLate)).toBe(false);
  });
});

describe("removing a member", () => {
  it("removes one of several", () => {
    expect(checkMemberRemoval("u2", ["u1", "u2"])).toBeNull();
  });

  it("refuses the last member, who is the only way back into the workspace", () => {
    // The subscription outlives the membership: a workspace with nobody in it
    // goes on being billed with no one able to sign in and cancel it.
    expect(checkMemberRemoval("u1", ["u1"])).toBe("last_member");
  });

  it("refuses somebody who is not in the workspace", () => {
    expect(checkMemberRemoval("u9", ["u1", "u2"])).toBe("not_a_member");
  });

  it("lets a member remove themselves while others remain", () => {
    expect(checkMemberRemoval("u1", ["u1", "u2"])).toBeNull();
  });
});

describe("the address an invite is keyed by", () => {
  it("folds case and trims, and nothing else", () => {
    expect(normaliseInviteEmail("  Someone@Example.TEST ")).toBe("someone@example.test");
    // Dots and +tags are left alone: whether two such addresses are one
    // mailbox is the receiving provider's business, not ours to assume.
    expect(normaliseInviteEmail("some.one+tag@example.test")).toBe("some.one+tag@example.test");
  });
});
