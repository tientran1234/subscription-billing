/**
 * Runs against a real Postgres, because the guarantees being tested here are
 * database guarantees — a unique index and a conditional UPDATE. Mocking the
 * database would test the mock.
 *
 *   pnpm db:up && pnpm db:push && pnpm test
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  applyEvent,
  confirmPlanChange,
  entitlementsForTenant,
  previewPlanChange,
  startCheckout,
  startPortalSession,
} from "@/server/billing.service";
import { meter } from "@/server/usage";
import type { BillingEvent } from "@/domain/billing-event";
import { CURRENCIES, DEFAULT_CURRENCY } from "@/domain/currency";
import { PLANS } from "@/domain/entitlements";
import { FakeProvider } from "@/providers/fake";
import { QUOTE_TTL_SECONDS } from "@/domain/plan-change";

const hasDatabase = Boolean(process.env.DATABASE_URL);

const event = (over: Partial<BillingEvent> & { providerEventId: string }): BillingEvent => ({
  type: "subscription_activated",
  ...over,
});

/**
 * `n` people who can act for this tenant — the thing that occupies a seat.
 * Memberships cascade with the tenant, so nothing has to tidy them up.
 */
const members = async (tenantId: string, n: number) => {
  for (let i = 0; i < n; i++) {
    const user = await db.user.create({
      data: { email: `member-${randomUUID()}@example.test` },
    });
    await db.membership.create({ data: { userId: user.id, tenantId } });
  }
};

/**
 * Run whole, once per currency we sell. The state machine and the entitlements
 * derived from it are the same code whatever was paid in — this is what says
 * so: every outcome and every entitlement below is asserted against a
 * subscription billed in dong exactly as against one billed in dollars.
 */
describe.skipIf(!hasDatabase).each(CURRENCIES)("billing service in %s", (currency) => {
  let tenantId: string;
  let subscriptionId: string;

  beforeEach(async () => {
    await db.webhookEvent.deleteMany();
    await db.tenant.deleteMany();

    const tenant = await db.tenant.create({
      data: { email: `t${Date.now()}@example.test`, name: "Test tenant" },
    });
    tenantId = tenant.id;

    const subscription = await db.subscription.create({
      data: { tenantId, planKey: "pro", status: "PENDING", checkoutRef: "cs_test_1", currency },
    });
    subscriptionId = subscription.id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("activates on the first delivery and ignores the replay", async () => {
    const e = event({ providerEventId: "evt_1", checkoutRef: "cs_test_1", providerRef: "sub_1" });

    expect(await applyEvent("stripe", e)).toBe("transitioned");
    expect(await applyEvent("stripe", e)).toBe("duplicate");

    const row = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(row.status).toBe("ACTIVE");
    expect(row.providerRef).toBe("sub_1");
  });

  it("lets only one of two concurrent activations win", async () => {
    // Different event ids, so idempotency does not cover this — the conditional
    // UPDATE is the only thing standing between them.
    const outcomes = await Promise.all([
      applyEvent("stripe", event({ providerEventId: "evt_a", checkoutRef: "cs_test_1" })),
      applyEvent("stripe", event({ providerEventId: "evt_b", checkoutRef: "cs_test_1" })),
    ]);

    expect(outcomes.filter((o) => o === "transitioned")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "no_transition")).toHaveLength(1);
  });

  it("extends the period on renewal without touching the status", async () => {
    await applyEvent("stripe", event({ providerEventId: "evt_1", checkoutRef: "cs_test_1", providerRef: "sub_1" }));

    const nextPeriod = new Date("2027-01-01T00:00:00.000Z");
    const outcome = await applyEvent(
      "stripe",
      event({ providerEventId: "evt_2", providerRef: "sub_1", currentPeriodEnd: nextPeriod }),
    );

    expect(outcome).toBe("renewed");
    const row = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(row.status).toBe("ACTIVE");
    expect(row.currentPeriodEnd?.toISOString()).toBe(nextPeriod.toISOString());
  });

  it("does not apply an out-of-order cancellation to a fresh subscription twice", async () => {
    await applyEvent("stripe", event({ providerEventId: "evt_1", checkoutRef: "cs_test_1", providerRef: "sub_1" }));
    await applyEvent("stripe", event({ providerEventId: "evt_2", type: "subscription_canceled", providerRef: "sub_1" }));

    const again = await applyEvent(
      "stripe",
      event({ providerEventId: "evt_3", type: "subscription_canceled", providerRef: "sub_1" }),
    );
    expect(again).toBe("no_transition");
  });

  it("revokes paid entitlements as soon as the subscription is cancelled", async () => {
    await applyEvent("stripe", event({ providerEventId: "evt_1", checkoutRef: "cs_test_1", providerRef: "sub_1" }));
    expect((await entitlementsForTenant(tenantId)).planKey).toBe("pro");

    await applyEvent("stripe", event({ providerEventId: "evt_2", type: "subscription_canceled", providerRef: "sub_1" }));
    expect((await entitlementsForTenant(tenantId)).planKey).toBe("free");
  });

  it("moves the plan when an invoice for another one is paid", async () => {
    await applyEvent("stripe", event({ providerEventId: "evt_1", checkoutRef: "cs_test_1", providerRef: "sub_1" }));
    expect((await entitlementsForTenant(tenantId)).planKey).toBe("pro");

    const outcome = await applyEvent(
      "stripe",
      event({ providerEventId: "evt_2", providerRef: "sub_1", planKey: "scale" }),
    );

    // The status did not move — only the plan did, and the tenant has the
    // features they just paid the proration for.
    expect(outcome).toBe("repriced");
    const row = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(row.status).toBe("ACTIVE");
    expect((await entitlementsForTenant(tenantId)).planKey).toBe("scale");
  });

  it("does not let a late invoice put the tenant back on the plan they left", async () => {
    await applyEvent(
      "stripe",
      event({
        providerEventId: "evt_1",
        checkoutRef: "cs_test_1",
        providerRef: "sub_1",
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
    );
    await applyEvent("stripe", event({ providerEventId: "evt_2", providerRef: "sub_1", planKey: "scale" }));

    // A renewal raised before the upgrade, delivered after it.
    const outcome = await applyEvent(
      "stripe",
      event({
        providerEventId: "evt_3",
        providerRef: "sub_1",
        planKey: "pro",
        currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
      }),
    );

    expect(outcome).toBe("renewed");
    expect((await entitlementsForTenant(tenantId)).planKey).toBe("scale");
  });

  it("runs a trial that converts, and leaves the trial-ending notice alone", async () => {
    const started = await applyEvent(
      "stripe",
      event({
        providerEventId: "evt_1",
        type: "subscription_trialing",
        checkoutRef: "cs_test_1",
        providerRef: "sub_1",
      }),
    );
    expect(started).toBe("transitioned");

    let row = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(row.status).toBe("TRIALING");
    // The whole point of the trial: the plan, not a sample of it.
    expect((await entitlementsForTenant(tenantId)).planKey).toBe("pro");

    // The provider's heads-up. Recorded, and it moves nothing — a replay of it
    // loses on the event id like every other delivery.
    const warning = event({
      providerEventId: "evt_2",
      type: "trial_ending",
      providerRef: "sub_1",
    });
    expect(await applyEvent("stripe", warning)).toBe("ignored");
    expect(await applyEvent("stripe", warning)).toBe("duplicate");

    row = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(row.status).toBe("TRIALING");

    // The first invoice is paid: now it is a subscription.
    const converted = await applyEvent(
      "stripe",
      event({ providerEventId: "evt_3", providerRef: "sub_1" }),
    );
    expect(converted).toBe("transitioned");
    row = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(row.status).toBe("ACTIVE");
  });

  it("moves a trial whose first invoice is refused into dunning, not out of access", async () => {
    await applyEvent(
      "stripe",
      event({
        providerEventId: "evt_1",
        type: "subscription_trialing",
        checkoutRef: "cs_test_1",
        providerRef: "sub_1",
      }),
    );

    const outcome = await applyEvent(
      "stripe",
      event({ providerEventId: "evt_2", type: "payment_failed", providerRef: "sub_1" }),
    );

    expect(outcome).toBe("transitioned");
    const row = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(row.status).toBe("PAST_DUE");
    // PAST_DUE keeps paid access whichever status it came from: the card can
    // still be fixed, and cutting them off mid-retry is the bug that rule exists
    // to prevent.
    expect((await entitlementsForTenant(tenantId)).planKey).toBe("pro");
  });

  it("never puts an active subscription back into a trial", async () => {
    // A trial start delivered after the activation it preceded. Out-of-order
    // deliveries are the norm, and this one would be a free month.
    await applyEvent("stripe", event({ providerEventId: "evt_1", checkoutRef: "cs_test_1", providerRef: "sub_1" }));

    const late = await applyEvent(
      "stripe",
      event({
        providerEventId: "evt_2",
        type: "subscription_trialing",
        checkoutRef: "cs_test_1",
      }),
    );

    expect(late).toBe("no_transition");
    const row = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(row.status).toBe("ACTIVE");
  });

  it("hands the gateway the trial the plan sells, and no trial on a plan without one", async () => {
    const provider = new FakeProvider();
    await startCheckout(provider, {
      tenantId,
      planKey: "pro",
      priceRef: "price_pro",
      appUrl: "https://x",
    });
    await startCheckout(provider, {
      tenantId,
      planKey: "free",
      priceRef: "price_free",
      appUrl: "https://x",
    });

    expect(provider.checkouts.map((c) => c.trialDays)).toEqual([PLANS.pro.trialDays, 0]);
  });

  it("bills the gateway in the currency the checkout chose, and records it", async () => {
    const provider = new FakeProvider();
    const started = await startCheckout(provider, {
      tenantId,
      planKey: "pro",
      priceRef: "price_pro",
      currency,
      appUrl: "https://x",
    });

    expect(provider.checkouts).toMatchObject([{ currency }]);
    const row = await db.subscription.findFirstOrThrow({
      where: { id: started.ok ? started.subscriptionId : undefined },
    });
    // Recorded because it is what was bought, and because nothing may move it
    // afterwards — the gateway will not reprice a live subscription into
    // another currency.
    expect(row.currency).toBe(currency);
  });

  it("falls back to the default currency when a checkout names none", async () => {
    const provider = new FakeProvider();
    const started = await startCheckout(provider, {
      tenantId,
      planKey: "pro",
      priceRef: "price_pro",
      appUrl: "https://x",
    });

    const row = await db.subscription.findFirstOrThrow({
      where: { id: started.ok ? started.subscriptionId : undefined },
    });
    expect(row.currency).toBe(DEFAULT_CURRENCY);
  });

  // The same shape as the seat floor: refused before anything is written, so
  // no PENDING row is left behind for a webhook to attach itself to.
  it("refuses a checkout in a currency no plan is priced in", async () => {
    const provider = new FakeProvider();
    const before = await db.subscription.count({ where: { tenantId } });

    const started = await startCheckout(provider, {
      tenantId,
      planKey: "pro",
      priceRef: "price_pro",
      currency: "gbp",
      appUrl: "https://x",
    });

    expect(started).toEqual({ ok: false, reason: "unsupported_currency" });
    expect(provider.checkouts).toEqual([]);
    expect(await db.subscription.count({ where: { tenantId } })).toBe(before);
  });

  it("stores the seats a checkout bought and bills the gateway for them", async () => {
    const provider = new FakeProvider();
    const started = await startCheckout(provider, {
      tenantId,
      planKey: "pro",
      priceRef: "price_pro",
      seats: 4,
      appUrl: "https://x",
    });

    expect(started).toMatchObject({ ok: true });
    expect(provider.checkouts).toMatchObject([{ seats: 4 }]);
    const row = await db.subscription.findFirstOrThrow({
      where: { id: started.ok ? started.subscriptionId : undefined },
    });
    expect(row.seats).toBe(4);
  });

  it("buys one seat when the checkout does not ask for any", async () => {
    const provider = new FakeProvider();
    const started = await startCheckout(provider, {
      tenantId,
      planKey: "pro",
      priceRef: "price_pro",
      appUrl: "https://x",
    });

    expect(started).toMatchObject({ ok: true });
    expect(provider.checkouts).toMatchObject([{ seats: 1 }]);
  });

  // The floor at checkout, not only on a change: a subscription for fewer seats
  // than the workspace already fills is access it cannot hand out.
  it("refuses a checkout for fewer seats than the workspace has members", async () => {
    const provider = new FakeProvider();
    await members(tenantId, 3);
    const before = await db.subscription.count({ where: { tenantId } });

    const started = await startCheckout(provider, {
      tenantId,
      planKey: "pro",
      priceRef: "price_pro",
      seats: 2,
      appUrl: "https://x",
    });

    expect(started).toEqual({ ok: false, reason: "seats_in_use" });
    // Nothing was written and nothing was opened: a refusal leaves no PENDING
    // row behind for a webhook to attach itself to.
    expect(provider.checkouts).toEqual([]);
    expect(await db.subscription.count({ where: { tenantId } })).toBe(before);
  });

  it("moves the seat count when the invoice billed for it is paid", async () => {
    await applyEvent("stripe", event({ providerEventId: "evt_1", checkoutRef: "cs_test_1", providerRef: "sub_1" }));
    expect((await entitlementsForTenant(tenantId)).seats).toBe(1);

    const outcome = await applyEvent(
      "stripe",
      event({ providerEventId: "evt_2", providerRef: "sub_1", seats: 5 }),
    );

    // The status did not move — only the quantity did, and the workspace has
    // the seats it just paid the proration for.
    expect(outcome).toBe("repriced");
    const row = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(row.status).toBe("ACTIVE");
    expect(row.seats).toBe(5);
    expect((await entitlementsForTenant(tenantId)).seats).toBe(5);
  });

  it("does not let a late invoice sell the extra seats back", async () => {
    await applyEvent(
      "stripe",
      event({
        providerEventId: "evt_1",
        checkoutRef: "cs_test_1",
        providerRef: "sub_1",
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
    );
    await applyEvent("stripe", event({ providerEventId: "evt_2", providerRef: "sub_1", seats: 5 }));

    // A renewal raised before the seat change, delivered after it.
    const outcome = await applyEvent(
      "stripe",
      event({
        providerEventId: "evt_3",
        providerRef: "sub_1",
        seats: 1,
        currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
      }),
    );

    expect(outcome).toBe("renewed");
    expect((await entitlementsForTenant(tenantId)).seats).toBe(5);
  });

  it("counts every metered call and blocks the one past the limit", async () => {
    const limit = 2;
    expect((await meter(tenantId, "aiMessages", limit)).allowed).toBe(true);
    expect((await meter(tenantId, "aiMessages", limit)).allowed).toBe(true);

    const third = await meter(tenantId, "aiMessages", limit);
    expect(third).toMatchObject({ used: 3, allowed: false });
  });

  it("does not lose counts when requests race for the first row of a period", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => meter(tenantId, "aiMessages", 100)),
    );
    expect(Math.max(...results.map((r) => r.used))).toBe(8);
  });
});

describe.skipIf(!hasDatabase)("billing portal", () => {
  // The fake provider puts the customer it was asked about into the URL, which
  // is what lets these assertions see WHOSE portal was opened.
  const provider = new FakeProvider();
  let tenantId: string;

  const tenant = async (email: string) =>
    (await db.tenant.create({ data: { email, name: email } })).id;

  beforeEach(async () => {
    await db.tenant.deleteMany();
    tenantId = await tenant(`portal${Date.now()}@example.test`);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("has nothing to open before the first webhook has landed", async () => {
    await db.subscription.create({ data: { tenantId, planKey: "pro", status: "PENDING" } });
    expect(await startPortalSession(provider, { tenantId, appUrl: "https://x" })).toEqual({
      ok: false,
      reason: "no_customer",
    });
  });

  it("opens for the customer the tenant's newest subscription is billed to", async () => {
    // Explicit timestamps: the rule is "newest customer", and two rows created
    // in the same millisecond would not test it.
    await db.subscription.create({
      data: {
        tenantId,
        planKey: "pro",
        status: "CANCELED",
        customerRef: "cus_old",
        createdAt: new Date("2026-01-01"),
      },
    });
    await db.subscription.create({
      data: {
        tenantId,
        planKey: "scale",
        status: "ACTIVE",
        customerRef: "cus_current",
        createdAt: new Date("2026-06-01"),
      },
    });

    const result = await startPortalSession(provider, { tenantId, appUrl: "https://x" });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.portalUrl).toContain("cus_current");
  });

  it("never opens another tenant's portal", async () => {
    const otherId = await tenant(`other${Date.now()}@example.test`);
    // The other tenant's row is the NEWEST in the table, so a lookup that
    // forgot to filter by tenant would hand this caller that customer.
    await db.subscription.create({
      data: {
        tenantId,
        planKey: "pro",
        status: "ACTIVE",
        customerRef: "cus_mine",
        createdAt: new Date("2026-01-01"),
      },
    });
    await db.subscription.create({
      data: {
        tenantId: otherId,
        planKey: "pro",
        status: "ACTIVE",
        customerRef: "cus_victim",
        createdAt: new Date("2026-06-01"),
      },
    });

    const result = await startPortalSession(provider, { tenantId, appUrl: "https://x" });
    expect(result.ok && result.portalUrl).toContain("cus_mine");
    expect(result.ok && result.portalUrl).not.toContain("cus_victim");
  });

  it("sends the customer back to the account page when they are done", async () => {
    await db.subscription.create({
      data: { tenantId, planKey: "pro", status: "ACTIVE", customerRef: "cus_mine" },
    });
    const result = await startPortalSession(provider, { tenantId, appUrl: "https://app.test" });
    expect(result.ok && decodeURIComponent(result.portalUrl)).toContain(
      "https://app.test/account",
    );
  });
});

describe.skipIf(!hasDatabase)("plan change", () => {
  const price = { tenantId: "", planKey: "scale", priceRef: "price_scale" };
  let provider: FakeProvider;
  let tenantId: string;

  const subscribe = (over: Record<string, unknown>) =>
    db.subscription.create({
      data: { tenantId, planKey: "pro", status: "ACTIVE", providerRef: "sub_mine", ...over },
    });

  beforeEach(async () => {
    provider = new FakeProvider();
    await db.tenant.deleteMany();
    const tenant = await db.tenant.create({
      data: { email: `plan${Date.now()}@example.test`, name: "Plan tenant" },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("quotes the change against the caller's own subscription", async () => {
    await subscribe({});
    const result = await previewPlanChange(provider, { ...price, tenantId });

    expect(result.ok && result.preview.amountDueMinor).toBeGreaterThan(0);
    expect(provider.previews).toEqual([
      { providerRef: "sub_mine", priceRef: "price_scale", seats: 1, currency: DEFAULT_CURRENCY },
    ]);
  });

  it("has nothing to reprice before the provider has billed the tenant once", async () => {
    await subscribe({ status: "PENDING", providerRef: null });
    expect(await previewPlanChange(provider, { ...price, tenantId })).toEqual({
      ok: false,
      reason: "no_subscription",
    });
  });

  it("changes the plan at the provider, for the price that was quoted", async () => {
    await subscribe({});
    const preview = await previewPlanChange(provider, { ...price, tenantId });
    const prorationDate = preview.ok ? preview.preview.prorationDate : new Date(0);

    expect(await confirmPlanChange(provider, { ...price, tenantId, prorationDate })).toEqual({
      ok: true,
    });
    expect(provider.planChanges).toEqual([
      {
        providerRef: "sub_mine",
        priceRef: "price_scale",
        planKey: "scale",
        seats: 1,
        currency: DEFAULT_CURRENCY,
        prorationDate,
      },
    ]);
  });

  // Confirming leaves the subscription alone: the plan moves when the invoice
  // for it is paid, so a card that declines cannot cost the tenant the plan
  // they are still paying for.
  it("does not move the plan until the invoice for it is paid", async () => {
    const subscription = await subscribe({});
    await confirmPlanChange(provider, { ...price, tenantId, prorationDate: new Date() });

    const row = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.planKey).toBe("pro");
    expect((await entitlementsForTenant(tenantId)).planKey).toBe("pro");
  });

  it("refuses a quote too old to still be the price, and never asks the provider", async () => {
    await subscribe({});
    const stale = new Date(Date.now() - (QUOTE_TTL_SECONDS + 60) * 1000);

    expect(await confirmPlanChange(provider, { ...price, tenantId, prorationDate: stale })).toEqual({
      ok: false,
      reason: "stale_quote",
    });
    expect(provider.planChanges).toEqual([]);
  });

  it("refuses a subscription that is not being billed, and never asks the provider", async () => {
    await subscribe({ status: "PAST_DUE" });

    expect(
      await confirmPlanChange(provider, { ...price, tenantId, prorationDate: new Date() }),
    ).toEqual({ ok: false, reason: "not_billable" });
    expect(provider.planChanges).toEqual([]);
  });

  it("never reprices another tenant's subscription", async () => {
    const other = await db.tenant.create({
      data: { email: `victim${Date.now()}@example.test`, name: "Other tenant" },
    });
    // The other tenant's row is the newest in the table, so a lookup that
    // forgot to filter by tenant would reprice theirs.
    await subscribe({ createdAt: new Date("2026-01-01") });
    await db.subscription.create({
      data: {
        tenantId: other.id,
        planKey: "pro",
        status: "ACTIVE",
        providerRef: "sub_victim",
        createdAt: new Date("2026-06-01"),
      },
    });

    await confirmPlanChange(provider, { ...price, tenantId, prorationDate: new Date() });
    expect(provider.planChanges.map((c) => c.providerRef)).toEqual(["sub_mine"]);
  });

  it("quotes a seat change on the plan the tenant is already on", async () => {
    await subscribe({ seats: 2 });

    const result = await previewPlanChange(provider, {
      tenantId,
      planKey: "pro",
      priceRef: "price_pro",
      seats: 5,
    });

    expect(result.ok).toBe(true);
    expect(provider.previews).toMatchObject([{ seats: 5 }]);
  });

  // The guard, through the service: the seats in use are counted from the
  // workspace's own memberships, so a reduction that would strand somebody is
  // refused before the gateway is asked for a price.
  it("refuses dropping below the seats in use, and never asks the provider", async () => {
    await subscribe({ seats: 5 });
    await members(tenantId, 3);

    expect(
      await previewPlanChange(provider, {
        tenantId,
        planKey: "pro",
        priceRef: "price_pro",
        seats: 2,
      }),
    ).toEqual({ ok: false, reason: "seats_in_use" });
    expect(
      await confirmPlanChange(provider, {
        tenantId,
        planKey: "pro",
        priceRef: "price_pro",
        seats: 2,
        prorationDate: new Date(),
      }),
    ).toEqual({ ok: false, reason: "seats_in_use" });

    expect(provider.previews).toEqual([]);
    expect(provider.planChanges).toEqual([]);
  });

  it("gives back a seat nobody is holding any more", async () => {
    await subscribe({ seats: 5 });
    await members(tenantId, 2);

    const result = await previewPlanChange(provider, {
      tenantId,
      planKey: "pro",
      priceRef: "price_pro",
      seats: 2,
    });
    expect(result.ok).toBe(true);
  });

  // The currency is settled at checkout and read back off the row, never taken
  // from whoever is asking: the gateway fixed it when it created the
  // subscription and refuses to reprice a live one into another, so a quote in
  // any other currency is an amount the customer could not be charged.
  it("quotes and bills a change in the currency the subscription was bought in", async () => {
    await subscribe({ currency: "vnd" });

    const preview = await previewPlanChange(provider, { ...price, tenantId });
    const prorationDate = preview.ok ? preview.preview.prorationDate : new Date(0);
    await confirmPlanChange(provider, { ...price, tenantId, prorationDate });

    expect(preview.ok && preview.preview.currency).toBe("vnd");
    expect(provider.previews).toMatchObject([{ currency: "vnd" }]);
    expect(provider.planChanges).toMatchObject([{ currency: "vnd" }]);
  });

  // A plan move that names no seats keeps the ones already paid for. Billing it
  // at one would quietly take four seats off a workspace mid-upgrade.
  it("carries the seats across a plan move that does not mention them", async () => {
    await subscribe({ seats: 5 });
    await members(tenantId, 5);

    await confirmPlanChange(provider, { ...price, tenantId, prorationDate: new Date() });
    expect(provider.planChanges).toMatchObject([{ planKey: "scale", seats: 5 }]);
  });
});
