/**
 * The cap as it is stored: a nullable column, where null is an answer.
 *
 * Against a real Postgres because the distinction that matters is the one the
 * database makes — a workspace that has never set a cap and one that set zero
 * are different rows, and reading the first as the second would stop an add-on
 * every customer from before caps existed is paying for.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { UNCAPPED } from "@/domain/spend-cap";
import { setSpendCap, spendCapFor } from "@/server/spend-cap";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("storing a spend cap", () => {
  let tenantId: string;

  beforeEach(async () => {
    await db.tenant.deleteMany();
    tenantId = (
      await db.tenant.create({ data: { email: `c${Date.now()}@example.test`, name: "Acme" } })
    ).id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("reads no cap for a workspace that has never set one", async () => {
    expect(await spendCapFor(tenantId)).toBe(UNCAPPED);
  });

  it("keeps a cap of zero apart from no cap at all", async () => {
    await setSpendCap(tenantId, 0);
    expect(await spendCapFor(tenantId)).toBe(0);

    await setSpendCap(tenantId, UNCAPPED);
    expect(await spendCapFor(tenantId)).toBe(UNCAPPED);
  });

  it("replaces the cap rather than accumulating caps", async () => {
    await setSpendCap(tenantId, 500);
    await setSpendCap(tenantId, 100);
    expect(await spendCapFor(tenantId)).toBe(100);
  });

  it("does not read another workspace's cap", async () => {
    const other = await db.tenant.create({
      data: { email: `o${Date.now()}@example.test`, name: "Other" },
    });
    await setSpendCap(other.id, 7);

    expect(await spendCapFor(tenantId)).toBe(UNCAPPED);
  });
});
