/**
 * Putting names on the workspaces an account may act for.
 *
 * Against a real Postgres because the guarantee is about which rows come back:
 * the ids are taken from the session's memberships and the names are read for
 * those ids only, so a tenant nobody in this session belongs to must not reach
 * the picker however many of them the table holds. A stub for that read would
 * test the stub.
 *
 *   pnpm db:up && pnpm db:push && pnpm test
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type { Principal } from "@/domain/membership";
import type { Role } from "@/domain/role";
import { workspacesFor } from "@/server/workspaces";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("the workspaces a session may act for", () => {
  let userId: string;

  /** A workspace, with this account in it in the named role unless told not to. */
  const workspace = async (name: string, role: Role | null = "admin") => {
    const tenant = await db.tenant.create({
      data: { email: `${randomUUID()}@example.test`, name },
    });
    if (role) await db.membership.create({ data: { userId, tenantId: tenant.id, role } });
    return tenant.id;
  };

  /** The session as the auth callback builds it: the memberships and nothing else. */
  const principal = (...memberships: [string, Role][]): Principal => ({
    userId,
    memberships: memberships.map(([tenantId, role]) => ({ tenantId, role })),
  });

  beforeEach(async () => {
    await db.tenant.deleteMany();
    await db.user.deleteMany();
    userId = (await db.user.create({ data: { email: `${randomUUID()}@example.test` } })).id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("names each workspace, in the order the memberships came in", async () => {
    const acme = await workspace("Acme Ltd");
    const globex = await workspace("Globex", "member");

    expect(await workspacesFor(principal([acme, "admin"], [globex, "member"]))).toEqual([
      { tenantId: acme, role: "admin", name: "Acme Ltd" },
      { tenantId: globex, role: "member", name: "Globex" },
    ]);
  });

  it("leaves out a workspace this account is not a member of", async () => {
    const mine = await workspace("Mine");
    await workspace("Somebody else's", null);

    expect(await workspacesFor(principal([mine, "admin"]))).toEqual([
      { tenantId: mine, role: "admin", name: "Mine" },
    ]);
  });

  it("carries the role off the membership and not off the row it names", async () => {
    // The session is the answer to what this account may do, so a role edited
    // in the column after the session was built does not travel with the name.
    const mine = await workspace("Mine", "member");
    expect(await workspacesFor(principal([mine, "member"]))).toEqual([
      { tenantId: mine, role: "member", name: "Mine" },
    ]);
  });

  it("leaves out a workspace whose row has gone, rather than listing its id", async () => {
    const kept = await workspace("Kept");
    const deleted = await workspace("Deleted");
    await db.tenant.delete({ where: { id: deleted } });

    // The membership cascaded with it, so this is a session built before the
    // delete — and a choice that resolves to nothing is worse than one row less.
    expect(await workspacesFor(principal([kept, "admin"], [deleted, "admin"]))).toEqual([
      { tenantId: kept, role: "admin", name: "Kept" },
    ]);
  });

  it("reads nothing for an account with no workspace at all", async () => {
    expect(await workspacesFor(principal())).toEqual([]);
  });
});
