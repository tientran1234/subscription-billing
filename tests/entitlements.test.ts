import { describe, expect, it } from "vitest";
import { CURRENCIES } from "@/domain/currency";
import {
  PLANS,
  canUse,
  entitlementsFor,
  priceMinorFor,
  remaining,
  sellsMeteredOverage,
  trialDaysFor,
  type PlanKey,
} from "@/domain/entitlements";
import { MIN_SEATS } from "@/domain/seats";

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

  it("reports the seats that were paid for", () => {
    expect(entitlementsFor("pro", "ACTIVE", 7).seats).toBe(7);
    expect(entitlementsFor("pro", "TRIALING", 7).seats).toBe(7);
  });

  it("drops a cancelled tenant back to one seat along with the plan", () => {
    // Seats are derived for the same reason the plan is: a count that outlives
    // the subscription is paid access nobody is paying for.
    expect(entitlementsFor("pro", "CANCELED", 7).seats).toBe(MIN_SEATS);
  });

  it("never reports fewer than one seat, whatever it is handed", () => {
    expect(entitlementsFor("pro", "ACTIVE", 0).seats).toBe(MIN_SEATS);
    expect(entitlementsFor("free", "NONE").seats).toBe(MIN_SEATS);
  });

  it("bills past the quota only for a subscription that bought the add-on", () => {
    expect(entitlementsFor("pro", "ACTIVE", 1, true).meteredOverage).toBe(true);
    // A subscription opened before the add-on was sold has no meter at the
    // gateway, so letting it past its quota would be usage nobody can invoice.
    expect(entitlementsFor("pro", "ACTIVE", 1, false).meteredOverage).toBe(false);
  });

  it("keeps billing past the quota while a renewal is being retried", () => {
    // PAST_DUE keeps paid access, so the usage happens; a failed card is a
    // reason to write to the customer, not to hand them the month free.
    expect(entitlementsFor("pro", "PAST_DUE", 1, true).meteredOverage).toBe(true);
  });

  it("stops a trial at the quota instead of billing past it", () => {
    // A trial takes no money. One that ends with an invoice for the messages
    // it was spent judging the product on is not a trial.
    expect(entitlementsFor("pro", "TRIALING", 1, true).meteredOverage).toBe(false);
  });

  it("stops billing a cancelled workspace for what it uses", () => {
    expect(entitlementsFor("pro", "CANCELED", 1, true).meteredOverage).toBe(false);
  });

  it("bills nothing past a quota the plan sells as a ceiling", () => {
    expect(entitlementsFor("free", "ACTIVE", 1, true).meteredOverage).toBe(false);
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

describe("the metered add-on", () => {
  it("is sold with the paid plans and not with Free", () => {
    expect(sellsMeteredOverage("pro")).toBe(true);
    expect(sellsMeteredOverage("scale")).toBe(true);
    // Free has no subscription for a usage record to attach to.
    expect(sellsMeteredOverage("free")).toBe(false);
  });

  it("is not sold on a plan we dropped", () => {
    expect(sellsMeteredOverage("legacy-plan")).toBe(false);
  });
});

describe("plan prices", () => {
  const planKeys = Object.keys(PLANS) as PlanKey[];

  // A price per currency rather than one converted on read: a rate that moved
  // would reprice the catalogue between the page the customer read and the
  // invoice we send them.
  it("prices every plan we sell in every currency we sell in", () => {
    for (const planKey of planKeys) {
      for (const currency of CURRENCIES) {
        expect(priceMinorFor(planKey, currency)).toBeTypeOf("number");
      }
    }
  });

  it("gives Free away in all of them", () => {
    for (const currency of CURRENCIES) expect(priceMinorFor("free", currency)).toBe(0);
  });

  // A currency added to the list without a real amount on each paid plan would
  // otherwise read as a plan being given away.
  it("charges for the paid plans in all of them, in the same order", () => {
    for (const currency of CURRENCIES) {
      expect(priceMinorFor("pro", currency)).toBeGreaterThan(0);
      expect(priceMinorFor("scale", currency)).toBeGreaterThan(priceMinorFor("pro", currency));
    }
  });
});
