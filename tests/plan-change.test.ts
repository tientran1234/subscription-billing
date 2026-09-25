import { describe, expect, it } from "vitest";
import {
  QUOTE_TTL_SECONDS,
  checkPlanChange,
  isQuoteUsable,
  planKeyForPaidInvoice,
} from "@/domain/plan-change";

const active = (planKey: string) => ({ planKey, status: "ACTIVE" });

describe("plan change eligibility", () => {
  it("allows an upgrade and a downgrade between paid plans", () => {
    expect(checkPlanChange(active("pro"), "scale")).toEqual({ ok: true, planKey: "scale" });
    expect(checkPlanChange(active("scale"), "pro")).toEqual({ ok: true, planKey: "pro" });
  });

  it("refuses a plan it cannot price", () => {
    expect(checkPlanChange(active("pro"), "enterprise")).toMatchObject({ reason: "unknown_plan" });
  });

  it("refuses Free — leaving a paid plan is a cancellation, which happens at the provider", () => {
    expect(checkPlanChange(active("pro"), "free")).toMatchObject({ reason: "not_purchasable" });
  });

  it("refuses a plan the tenant is already on", () => {
    expect(checkPlanChange(active("pro"), "pro")).toMatchObject({ reason: "same_plan" });
  });

  // PAST_DUE keeps paid access, which makes it tempting to treat as billable.
  // It is not: an invoice is still outstanding, and a proration on top of it
  // bills the customer twice for one month.
  it("refuses any status that is not ACTIVE", () => {
    for (const status of ["PENDING", "PAST_DUE", "CANCELED", "EXPIRED"]) {
      expect(checkPlanChange({ planKey: "pro", status }, "scale")).toMatchObject({
        reason: "not_billable",
      });
    }
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
