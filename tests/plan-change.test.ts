import { describe, expect, it } from "vitest";
import { PLANS } from "@/domain/entitlements";
import {
  QUOTE_TTL_SECONDS,
  checkPlanChange,
  isQuoteUsable,
  planChangeOptions,
  planKeyForPaidInvoice,
  seatsForPaidInvoice,
  type CurrentPlan,
} from "@/domain/plan-change";
import { MAX_SEATS } from "@/domain/seats";

/** One seat, occupied by the one member — the shape of a solo workspace. */
const active = (planKey: string, seats = 1, seatsInUse = 1) => ({
  planKey,
  status: "ACTIVE",
  seats,
  seatsInUse,
});

describe("plan change eligibility", () => {
  it("allows an upgrade and a downgrade between paid plans", () => {
    expect(checkPlanChange(active("pro"), { planKey: "scale" })).toEqual({
      ok: true,
      planKey: "scale",
      seats: 1,
    });
    expect(checkPlanChange(active("scale"), { planKey: "pro" })).toEqual({
      ok: true,
      planKey: "pro",
      seats: 1,
    });
  });

  it("refuses a plan it cannot price", () => {
    expect(checkPlanChange(active("pro"), { planKey: "enterprise" })).toMatchObject({
      reason: "unknown_plan",
    });
  });

  it("refuses Free — leaving a paid plan is a cancellation, which happens at the provider", () => {
    expect(checkPlanChange(active("pro"), { planKey: "free" })).toMatchObject({
      reason: "not_purchasable",
    });
  });

  it("refuses the plan the tenant is already on at the seats they already have", () => {
    expect(checkPlanChange(active("pro"), { planKey: "pro" })).toMatchObject({
      reason: "same_plan",
    });
    expect(checkPlanChange(active("pro", 3), { planKey: "pro", seats: 3 })).toMatchObject({
      reason: "same_plan",
    });
  });

  // PAST_DUE keeps paid access, which makes it tempting to treat as billable.
  // It is not: an invoice is still outstanding, and a proration on top of it
  // bills the customer twice for one month.
  it("refuses any status that is not ACTIVE", () => {
    for (const status of ["PENDING", "PAST_DUE", "CANCELED", "EXPIRED"]) {
      expect(
        checkPlanChange({ planKey: "pro", status, seats: 1, seatsInUse: 1 }, { planKey: "scale" }),
      ).toMatchObject({ reason: "not_billable" });
    }
  });
});

describe("plan picker options", () => {
  const offered = (current: CurrentPlan) =>
    planChangeOptions(current)
      .filter((option) => option.refusal === null)
      .map((option) => option.planKey);

  it("offers the paid plans the tenant is not on", () => {
    expect(offered(active("pro"))).toEqual(["scale"]);
    expect(offered(active("scale"))).toEqual(["pro"]);
  });

  it("marks the plan the tenant is on instead of offering it", () => {
    const options = planChangeOptions(active("pro"));
    expect(options.find((option) => option.current)).toMatchObject({
      planKey: "pro",
      refusal: "same_plan",
    });
  });

  // Downgrading to Free is a cancellation, and cancellations happen at the
  // provider. A button here would take money off a subscription this app is
  // not allowed to end.
  it("never offers Free", () => {
    for (const planKey of ["free", "pro", "scale"]) {
      expect(offered(active(planKey))).not.toContain("free");
    }
  });

  it("offers nothing while the subscription is not billable", () => {
    for (const status of ["PENDING", "PAST_DUE", "CANCELED", "EXPIRED"]) {
      expect(offered({ planKey: "pro", status, seats: 1, seatsInUse: 1 })).toEqual([]);
    }
  });

  it("covers every plan we sell, so a new one needs no edit here", () => {
    expect(planChangeOptions(active("pro")).map((option) => option.planKey)).toEqual(
      Object.keys(PLANS),
    );
  });

  // The guarantee the picker exists to keep: it draws a button only where the
  // confirm call would say yes. If these two ever disagree, the customer is
  // the one who finds out.
  it("agrees with the rule the route enforces, for every plan and status", () => {
    for (const status of ["ACTIVE", "PENDING", "PAST_DUE", "CANCELED", "EXPIRED"]) {
      for (const planKey of Object.keys(PLANS)) {
        for (const seats of [1, 3, 0]) {
          const current = { planKey, status, seats: 3, seatsInUse: 2 };
          for (const option of planChangeOptions(current, seats)) {
            const check = checkPlanChange(current, { planKey: option.planKey, seats });
            expect(option.refusal).toBe(check.ok ? null : check.reason);
          }
        }
      }
    }
  });
});

describe("seat changes", () => {
  // Seats are part of what is bought, so moving them on the plan already held
  // is a real change: there is a proration to quote and an invoice to raise.
  it("allows more seats on the plan the tenant is already on", () => {
    expect(checkPlanChange(active("pro"), { planKey: "pro", seats: 4 })).toEqual({
      ok: true,
      planKey: "pro",
      seats: 4,
    });
  });

  it("allows giving seats back, down to the ones in use", () => {
    expect(checkPlanChange(active("pro", 5, 2), { planKey: "pro", seats: 2 })).toMatchObject({
      ok: true,
      seats: 2,
    });
  });

  // The guard. Take it out and a workspace can pay for two seats while three
  // people hold one, and nothing says which of them loses their access.
  it("refuses fewer seats than are in use", () => {
    expect(checkPlanChange(active("pro", 5, 3), { planKey: "pro", seats: 2 })).toMatchObject({
      reason: "seats_in_use",
    });
    // Including on a plan move, which is the way round it would be missed.
    expect(checkPlanChange(active("pro", 5, 3), { planKey: "scale", seats: 1 })).toMatchObject({
      reason: "seats_in_use",
    });
  });

  it("refuses a count it cannot sell", () => {
    for (const seats of [0, -1, 2.5, MAX_SEATS + 1]) {
      expect(checkPlanChange(active("pro"), { planKey: "scale", seats })).toMatchObject({
        reason: "invalid_seats",
      });
    }
  });

  // A move that names no seats is a move of plan alone. Defaulting to one would
  // quietly take four seats off a workspace that is paying for five.
  it("carries the seats across a plan move that does not mention them", () => {
    expect(checkPlanChange(active("pro", 5, 5), { planKey: "scale" })).toMatchObject({
      ok: true,
      seats: 5,
    });
  });

  it("offers the current plan as soon as the seat count differs", () => {
    const current = active("pro", 2, 1);
    expect(planChangeOptions(current, 2).find((o) => o.current)?.refusal).toBe("same_plan");
    expect(planChangeOptions(current, 3).find((o) => o.current)?.refusal).toBeNull();
  });

  it("offers nothing at a seat count the route would refuse", () => {
    const offered = planChangeOptions(active("pro", 5, 3), 2).filter((o) => o.refusal === null);
    expect(offered).toEqual([]);
  });
});

describe("seats on a paid invoice", () => {
  const stored = { seats: 2, currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") };

  it("moves the seats the invoice was billed for", () => {
    expect(seatsForPaidInvoice(stored, { seats: 5 })).toBe(5);
  });

  it("leaves them alone when the invoice says nothing new", () => {
    expect(seatsForPaidInvoice(stored, {})).toBeNull();
    expect(seatsForPaidInvoice(stored, { seats: 2 })).toBeNull();
  });

  // The money has been taken, so the occupancy floor does not apply here: a
  // workspace that paid for five seats gets five, occupied or not. Only a count
  // we could not have sold at all is refused.
  it("writes a count below the seats in use, but not one we never sold", () => {
    expect(seatsForPaidInvoice({ seats: 5, currentPeriodEnd: null }, { seats: 1 })).toBe(1);
    for (const seats of [0, -2, 1.5, MAX_SEATS + 1]) {
      expect(seatsForPaidInvoice(stored, { seats })).toBeNull();
    }
  });

  // Webhooks arrive out of order. A renewal raised before a seat change but
  // delivered after it must not sell the extra seats back.
  it("ignores an invoice older than the period already stored", () => {
    expect(
      seatsForPaidInvoice(stored, {
        seats: 5,
        currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).toBeNull();
  });
});

describe("quote freshness", () => {
  const quotedAt = new Date("2026-09-25T12:00:00.000Z");
  const later = (seconds: number) => new Date(quotedAt.getTime() + seconds * 1000);

  it("holds for as long as the quote is valid", () => {
    expect(isQuoteUsable(quotedAt, quotedAt)).toBe(true);
    expect(isQuoteUsable(quotedAt, later(QUOTE_TTL_SECONDS))).toBe(true);
  });

  it("expires rather than charging an amount the customer was never shown", () => {
    expect(isQuoteUsable(quotedAt, later(QUOTE_TTL_SECONDS + 1))).toBe(false);
  });

  it("rejects an instant that no preview can have produced", () => {
    expect(isQuoteUsable(later(60), quotedAt)).toBe(false);
  });
});

describe("plan on a paid invoice", () => {
  const stored = { planKey: "pro", currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") };

  it("moves the plan when the paid invoice was raised for another one", () => {
    expect(planKeyForPaidInvoice(stored, { planKey: "scale" })).toBe("scale");
  });

  it("leaves the plan alone on an ordinary renewal", () => {
    expect(planKeyForPaidInvoice(stored, { planKey: "pro" })).toBeNull();
    expect(planKeyForPaidInvoice(stored, {})).toBeNull();
  });

  // Entitlements are derived from planKey: writing one we have no plan for
  // would silently drop the tenant to Free right after they paid.
  it("never writes a plan it cannot price", () => {
    expect(planKeyForPaidInvoice(stored, { planKey: "legacy_gold" })).toBeNull();
  });

  it("ignores an invoice older than the period already on the subscription", () => {
    // A renewal for the period that has just ended, delivered late: it was
    // raised before the upgrade and would put the tenant back on Pro.
    expect(
      planKeyForPaidInvoice(
        { planKey: "scale", currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") },
        { planKey: "pro", currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z") },
      ),
    ).toBeNull();
  });

  it("accepts the proration invoice for the period it is already in", () => {
    // Changing plan mid-cycle does not move the billing date, so the proration
    // invoice carries the very period end we have stored.
    expect(planKeyForPaidInvoice(stored, { planKey: "scale", currentPeriodEnd: stored.currentPeriodEnd })).toBe(
      "scale",
    );
  });
});
