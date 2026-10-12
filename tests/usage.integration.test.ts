/**
 * Giving a counted unit back, against a real Postgres.
 *
 * The part worth testing is the one the database decides: the decrement is
 * conditional on the row holding the units, so what keeps a counter off a
 * negative figure is a `where` and an affected-row count rather than anything
 * Node checked first. Against an in-memory stand-in this would be a test of
 * the stand-in.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { OVERAGE_QUOTA } from "@/domain/overage";
import { currentPeriod, meter, refund } from "@/server/usage";

const hasDatabase = Boolean(process.env.DATABASE_URL);

/** How many messages this month has been billed for so far. */
async function counted(tenantId: string, now = new Date()): Promise<number | null> {
  const row = await db.usageCounter.findUnique({
    where: {
      tenantId_feature_period: {
        tenantId,
        feature: OVERAGE_QUOTA,
        period: currentPeriod(now),
      },
    },
  });
  return row?.used ?? null;
}

describe.skipIf(!hasDatabase)("giving a metered unit back", () => {
  let tenantId: string;

  beforeEach(async () => {
    await db.tenant.deleteMany();
    tenantId = (
      await db.tenant.create({ data: { email: `u${Date.now()}@example.test`, name: "Acme" } })
    ).id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("takes back the unit a call counted", async () => {
    await meter(tenantId, OVERAGE_QUOTA, 50);
    expect(await refund(tenantId, OVERAGE_QUOTA)).toBe(true);
    expect(await counted(tenantId)).toBe(0);
  });

  // The counter is what the overage job bills the month from, so a figure
  // below zero would discount an invoice rather than leave one message off it.
  it("will not count a month below nothing", async () => {
    await meter(tenantId, OVERAGE_QUOTA, 50);
    expect(await refund(tenantId, OVERAGE_QUOTA)).toBe(true);
    expect(await refund(tenantId, OVERAGE_QUOTA)).toBe(false);
    expect(await counted(tenantId)).toBe(0);
  });

  it("has nothing to give back for a month that counted nothing", async () => {
    expect(await refund(tenantId, OVERAGE_QUOTA)).toBe(false);
    // And did not write a row to say so: a period nothing was metered in is
    // one the job must keep reading as nothing.
    expect(await counted(tenantId)).toBeNull();
  });

  // The whole point of the refund rather than metering after the call: the
  // allowance the failed call spent is there for the next one.
  it("leaves the allowance where it was before the call that failed", async () => {
    const limit = 2;
    expect((await meter(tenantId, OVERAGE_QUOTA, limit)).allowed).toBe(true);
    expect((await meter(tenantId, OVERAGE_QUOTA, limit)).allowed).toBe(true);
    await refund(tenantId, OVERAGE_QUOTA);

    // Without the unit back, this is the third call of a quota of two.
    expect((await meter(tenantId, OVERAGE_QUOTA, limit)).allowed).toBe(true);
    expect(await counted(tenantId)).toBe(limit);
  });

  // A quota bucket is a UTC month, and a refund belongs to the month that
  // counted the unit — a later run giving one back would take it off a month
  // that never sold it.
  it("gives back only in the period the unit was counted in", async () => {
    const counting = new Date("2026-03-15T00:00:00Z");
    const nextMonth = new Date("2026-04-01T00:00:00Z");
    await meter(tenantId, OVERAGE_QUOTA, 50, 1, counting);

    expect(await refund(tenantId, OVERAGE_QUOTA, 1, nextMonth)).toBe(false);
    expect(await counted(tenantId, counting)).toBe(1);

    expect(await refund(tenantId, OVERAGE_QUOTA, 1, counting)).toBe(true);
    expect(await counted(tenantId, counting)).toBe(0);
  });
});
