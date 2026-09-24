/**
 * Runs against a real Postgres, because the guarantees being tested here are
 * database guarantees — a unique index and a conditional UPDATE. Mocking the
 * database would test the mock.
 *
 *   pnpm db:up && pnpm db:push && pnpm test
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { applyEvent, entitlementsForTenant, startPortalSession } from "@/server/billing.service";
import { meter } from "@/server/usage";
import type { BillingEvent } from "@/domain/billing-event";
import { FakeProvider } from "@/providers/fake";

const hasDatabase = Boolean(process.env.DATABASE_URL);

const event = (over: Partial<BillingEvent> & { providerEventId: string }): BillingEvent => ({
  type: "subscription_activated",
  ...over,
});

describe.skipIf(!hasDatabase)("billing service", () => {
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
      data: { tenantId, planKey: "pro", status: "PENDING", checkoutRef: "cs_test_1" },
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
