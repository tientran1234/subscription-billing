/**
 * Runs against a real Postgres, because "this month is billed once" is a
 * primary key. A mocked database would only prove the mock refuses a second
 * insert, and what has to hold here is that two runs of the job — a scheduler
 * firing twice, a retry after a crash — cannot both bill the same month.
 *
 *   pnpm db:up && pnpm db:push && pnpm test
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { PLANS } from "@/domain/entitlements";
import { OVERAGE_QUOTA } from "@/domain/overage";
import { FakeProvider } from "@/providers/fake";
import { setSpendCap } from "@/server/spend-cap";
import { meter } from "@/server/usage";
import { reportOverage } from "@/server/usage-report";

const hasDatabase = Boolean(process.env.DATABASE_URL);

/** Inside October, so September is the month that has just closed. */
const NOW = new Date("2026-10-07T12:00:00.000Z");
const CLOSED = "2026-09";
const QUOTA = PLANS.pro.quotas[OVERAGE_QUOTA];

/** A gateway that will not take the report — an outage, not a bad figure. */
class BrokenProvider extends FakeProvider {
  async reportUsage(): Promise<void> {
    throw new Error("the gateway is down");
  }
}

describe.skipIf(!hasDatabase)("reporting a month of overage", () => {
  let tenantId: string;
  let provider: FakeProvider;

  /** Usage metered inside the closed month, through the counter the job reads. */
  const used = (n: number, period = CLOSED) =>
    meter(tenantId, OVERAGE_QUOTA, QUOTA, n, new Date(`${period}-15T00:00:00.000Z`));

  const subscribe = (over: Record<string, unknown> = {}) =>
    db.subscription.create({
      data: {
        tenantId,
        planKey: "pro",
        status: "ACTIVE",
        providerRef: "sub_metered",
        meteredOverage: true,
        ...over,
      },
    });

  const reports = () => db.usageReport.findMany();

  beforeEach(async () => {
    await db.tenant.deleteMany();
    provider = new FakeProvider();

    const tenant = await db.tenant.create({
      data: { email: `t${Date.now()}@example.test`, name: "Acme" },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("reports the units past the quota, and claims the month", async () => {
    await subscribe();
    await used(QUOTA + 500);

    const result = await reportOverage(provider, { tenantId, now: NOW });

    expect(result).toEqual({ ok: true, outcome: "reported", period: CLOSED, units: 500 });
    // The units, never the counter: the plan has already paid for the quota.
    expect(provider.usageReports).toMatchObject([
      { providerRef: "sub_metered", quantity: 500, period: CLOSED },
    ]);
    expect(await reports()).toMatchObject([{ period: CLOSED, quantity: 500 }]);
  });

  it("reports the month that has just closed when asked for no month at all", async () => {
    await subscribe();
    await used(QUOTA + 1);

    // What a scheduler calls: it knows when it ran, not which bucket the meter
    // put the usage in.
    const result = await reportOverage(provider, { tenantId, now: NOW });
    expect(result).toMatchObject({ period: CLOSED });
  });

  it("bills a month once however many times the job runs", async () => {
    await subscribe();
    await used(QUOTA + 500);

    const first = await reportOverage(provider, { tenantId, now: NOW });
    const second = await reportOverage(provider, { tenantId, now: NOW });
    const third = await reportOverage(provider, { tenantId, period: CLOSED, now: NOW });

    expect(first).toMatchObject({ outcome: "reported" });
    // The claim is what refuses the second and third, not a check of whether a
    // report has gone out — that read would be a window two runs come through.
    expect(second).toMatchObject({ outcome: "duplicate", units: 500 });
    expect(third).toMatchObject({ outcome: "duplicate", units: 500 });
    expect(provider.usageReports).toHaveLength(1);
    expect(await reports()).toHaveLength(1);
  });

  it("refuses a month that is still accruing, and claims nothing", async () => {
    await subscribe();
    await used(QUOTA + 500, "2026-10");

    // Claimed now, the month would be billed on a partial figure and every
    // message sent for the rest of it would have nowhere left to go.
    expect(await reportOverage(provider, { tenantId, period: "2026-10", now: NOW })).toEqual({
      ok: false,
      reason: "period_open",
      period: "2026-10",
    });
    expect(provider.usageReports).toHaveLength(0);
    expect(await reports()).toHaveLength(0);
  });

  it("bills nothing for a month that stayed inside the quota", async () => {
    await subscribe();
    await used(QUOTA);

    expect(await reportOverage(provider, { tenantId, now: NOW })).toMatchObject({
      outcome: "no_overage",
      units: 0,
    });
    expect(provider.usageReports).toHaveLength(0);
    // Nothing claimed: there is no figure, so there is nothing a second run
    // could send twice.
    expect(await reports()).toHaveLength(0);
  });

  it("bills the cap, not the counter, for a month that ran past its ceiling", async () => {
    await subscribe();
    await setSpendCap(tenantId, 100);
    // Past the ceiling by a long way. The route refuses these as they are made,
    // but it refuses them after `meter` has counted them — so the counter the
    // job reads is above the cap whatever the route did.
    await used(QUOTA + 900);

    const result = await reportOverage(provider, { tenantId, now: NOW });

    expect(result).toEqual({ ok: true, outcome: "reported", period: CLOSED, units: 100 });
    // The guarantee, written where the money is: the invoice carries the cap.
    expect(provider.usageReports).toMatchObject([{ quantity: 100, period: CLOSED }]);
    expect(await reports()).toMatchObject([{ period: CLOSED, quantity: 100 }]);
  });

  it("bills nothing at all for a workspace that capped itself at zero", async () => {
    await subscribe();
    await setSpendCap(tenantId, 0);
    await used(QUOTA + 900);

    // A ceiling the customer put back, so there is no figure and nothing is
    // claimed — the same shape as a month that stayed inside its quota.
    expect(await reportOverage(provider, { tenantId, now: NOW })).toMatchObject({
      outcome: "capped",
      units: 0,
    });
    expect(provider.usageReports).toHaveLength(0);
    expect(await reports()).toHaveLength(0);
  });

  it("bills the whole figure for a workspace that set no cap", async () => {
    await subscribe();
    await used(QUOTA + 500);

    // What every workspace from before caps existed has: a null column is no
    // ceiling, not a ceiling of zero, so the add-on they pay for still bills.
    expect(await reportOverage(provider, { tenantId, now: NOW })).toMatchObject({
      outcome: "reported",
      units: 500,
    });
  });

  it("bills nothing for a subscription bought without the add-on", async () => {
    await subscribe({ meteredOverage: false });
    await used(QUOTA + 500);

    // Those calls were refused with a 429 as they were made. Billing for them
    // now would charge for messages nobody was allowed to send.
    expect(await reportOverage(provider, { tenantId, now: NOW })).toMatchObject({
      outcome: "not_metered",
    });
    expect(provider.usageReports).toHaveLength(0);
  });

  it("stops billing a workspace whose subscription has ended", async () => {
    await subscribe({ status: "CANCELED" });
    await used(QUOTA + 500);

    // Entitlements fall back to Free the moment the subscription does, so the
    // quota that outlives it is a ceiling and there is nothing to invoice
    // against either.
    expect(await reportOverage(provider, { tenantId, now: NOW })).toMatchObject({
      outcome: "not_metered",
    });
  });

  it("has nowhere to report for a tenant the gateway is not billing", async () => {
    await subscribe({ providerRef: null, status: "PENDING" });
    await used(QUOTA + 500);

    expect(await reportOverage(provider, { tenantId, now: NOW })).toMatchObject({
      ok: false,
      reason: "no_subscription",
    });
  });

  it("bills the newest subscription only, so a workspace that resubscribed pays once", async () => {
    // The counter belongs to the workspace rather than to one of its
    // subscription rows, so a job that walked the rows would bill the same
    // month once per row.
    await subscribe({ status: "CANCELED", providerRef: "sub_old" });
    await subscribe({ providerRef: "sub_new" });
    await used(QUOTA + 500);

    await reportOverage(provider, { tenantId, now: NOW });

    expect(provider.usageReports).toMatchObject([{ providerRef: "sub_new", quantity: 500 }]);
    expect(await reports()).toHaveLength(1);
  });

  it("releases the claim when the gateway refuses the report", async () => {
    await subscribe();
    await used(QUOTA + 500);

    expect(await reportOverage(new BrokenProvider(), { tenantId, now: NOW })).toMatchObject({
      ok: false,
      reason: "report_failed",
    });
    // A row here would mean the gateway had been told. It was not, and the
    // claim left behind would block every later run as well as lie.
    expect(await reports()).toHaveLength(0);

    expect(await reportOverage(provider, { tenantId, now: NOW })).toMatchObject({
      outcome: "reported",
      units: 500,
    });
    expect(provider.usageReports).toHaveLength(1);
  });
});
