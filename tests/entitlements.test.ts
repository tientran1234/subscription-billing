import { describe, expect, it } from "vitest";
import { PLANS, canUse, entitlementsFor, remaining, trialDaysFor } from "@/domain/entitlements";

describe("entitlements", () => {
  it("gives a paying active tenant their plan", () => {
    const e = entitlementsFor("pro", "ACTIVE");
    expect(e.planKey).toBe("pro");
    expect(canUse(e, "export")).toBe(true);
  });

  it("drops a cancelled Pro tenant to Free immediately", () => {
    // The bug this guards: entitlements copied onto the user row survive the
    // cancellation and the tenant keeps paid features until someone notices.
    const e = entitlementsFor("pro", "CANCELED");
    expect(e.planKey).toBe("free");
    expect(canUse(e, "export")).toBe(false);
  });

  it("keeps access while a renewal is being retried", () => {
    expect(entitlementsFor("pro", "PAST_DUE").planKey).toBe("pro");
  });

  it("does not grant paid access before checkout completes", () => {
    expect(entitlementsFor("scale", "PENDING").planKey).toBe("free");
  });

  it("falls back to Free for a plan key that no longer exists", () => {
    expect(entitlementsFor("legacy-plan", "ACTIVE").planKey).toBe("free");
  });

  it("gives a trialing tenant exactly what the plan gives a paying one", () => {
    // The point of a trial is that the customer evaluates the real plan. Drop
    // TRIALING from the paid statuses and they spend the trial on Free,
    // judging a product nobody is selling them.
    expect(entitlementsFor("scale", "TRIALING")).toEqual(entitlementsFor("scale", "ACTIVE"));
    expect(canUse(entitlementsFor("scale", "TRIALING"), "sso")).toBe(true);
  });

  it("never reports negative quota left", () => {
    const e = entitlementsFor("free", "ACTIVE");
    expect(remaining(e, "aiMessages", 999)).toBe(0);
  });
});

describe("trial length", () => {
  it("reads the trial off the plan that is being bought", () => {
    expect(trialDaysFor("pro")).toBe(PLANS.pro.trialDays);
    expect(trialDaysFor("pro")).toBeGreaterThan(0);
  });

  it("offers no trial on Free, which is not sold, or on a plan we dropped", () => {
    expect(trialDaysFor("free")).toBe(0);
    expect(trialDaysFor("legacy-plan")).toBe(0);
  });
});
