/**
 * Runs against a real Postgres, because what is being tested is what survives
 * in the table: a grant written in the same transaction as the column it
 * describes, and a row that outlives the membership and the account it names.
 * Mocking the database would test the mock.
 *
 *   pnpm db:up && pnpm db:push && pnpm test
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ROLE_HISTORY_WINDOW } from "@/domain/role-history";
import { recordRoleGrant, roleHistoryOf } from "@/server/role-history";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("the roles a workspace has handed out", () => {
  let tenantId: string;
  let ownerId: string;
  let ownerEmail: string;

  const owner = () => ({ userId: ownerId, email: ownerEmail });

  beforeEach(async () => {
    await db.tenant.deleteMany();
    await db.user.deleteMany();

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

  /** Somebody in the workspace to have a role handed to. */
  const member = async (role = "member") => {
    const user = await db.user.create({ data: { email: `m-${randomUUID()}@example.test` } });
    await db.membership.create({ data: { userId: user.id, tenantId, role } });
    return { userId: user.id, email: user.email };
  };

  it("records who gave which role to whom", async () => {
    const subject = await member();

    expect(
      await recordRoleGrant(db, {
        tenantId,
        subject,
        grantedBy: owner(),
        role: "admin",
        previousRole: "member",
      }),
    ).toBe(true);

    expect(await roleHistoryOf(tenantId)).toEqual([
      {
        id: expect.any(String),
        subjectEmail: subject.email,
        grantedByEmail: ownerEmail,
        role: "admin",
        grantedAt: expect.any(Date),
      },
    ]);
  });

  it("records nothing for a write that left the role as it was", async () => {
    const subject = await member("admin");

    expect(
      await recordRoleGrant(db, {
        tenantId,
        subject,
        grantedBy: owner(),
        role: "admin",
        previousRole: "admin",
      }),
    ).toBe(false);
    expect(await roleHistoryOf(tenantId)).toEqual([]);
  });

  it("reads the grants newest first, a window at a time", async () => {
    const subject = await member();
    // One more than the window, so the oldest is the one left out.
    for (let i = 0; i <= ROLE_HISTORY_WINDOW; i += 1) {
      await recordRoleGrant(db, {
        tenantId,
        subject,
        grantedBy: owner(),
        role: i % 2 === 0 ? "admin" : "member",
        previousRole: i % 2 === 0 ? "member" : "admin",
      });
    }

    const history = await roleHistoryOf(tenantId);
    expect(history).toHaveLength(ROLE_HISTORY_WINDOW);
    const times = history.map((grant) => grant.grantedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("keeps a grant after the account it names is gone", async () => {
    // The row has no relation to User precisely so that this holds: a
    // workspace asking who made somebody an admin is usually asking about
    // somebody who has since left.
    const subject = await member();
    await recordRoleGrant(db, {
      tenantId,
      subject,
      grantedBy: owner(),
      role: "admin",
      previousRole: "member",
    });

    await db.user.delete({ where: { id: subject.userId } });

    expect(await db.membership.findMany({ where: { tenantId, userId: subject.userId } })).toEqual(
      [],
    );
    expect(await roleHistoryOf(tenantId)).toMatchObject([
      { subjectEmail: subject.email, grantedByEmail: ownerEmail, role: "admin" },
    ]);
  });

  it("reads only this workspace's grants", async () => {
    const other = await db.tenant.create({
      data: { email: `other-${randomUUID()}@example.test`, name: "Other" },
    });
    const subject = await member();
    await recordRoleGrant(db, {
      tenantId: other.id,
      subject,
      grantedBy: owner(),
      role: "admin",
      previousRole: null,
    });

    expect(await roleHistoryOf(tenantId)).toEqual([]);
    expect(await roleHistoryOf(other.id)).toHaveLength(1);
  });
});
