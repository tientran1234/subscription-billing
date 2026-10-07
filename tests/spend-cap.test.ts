import { describe, expect, it } from "vitest";
import {
  MAX_SPEND_CAP,
  UNCAPPED,
  billableOverageUnits,
  checkSpendCap,
  withinSpendCap,
} from "@/domain/spend-cap";

describe("a cap a workspace may set", () => {
  it("takes a whole number of units, and no cap at all", () => {
    expect(checkSpendCap(500)).toBeNull();
    expect(checkSpendCap(UNCAPPED)).toBeNull();
  });

  it("takes zero — the customer asking for their quota to be a ceiling again", () => {
    expect(checkSpendCap(0)).toBeNull();
  });

  it("refuses a cap that is not a whole number of units", () => {
    expect(checkSpendCap(1.5)).toBe("invalid_cap");
    expect(checkSpendCap(Number.NaN)).toBe("invalid_cap");
  });

  it("refuses a negative cap, which is not a smaller bill but a credit", () => {
    expect(checkSpendCap(-1)).toBe("invalid_cap");
  });

  it("refuses one past the bound, so a slip in a number field is not a ceiling", () => {
    expect(checkSpendCap(MAX_SPEND_CAP)).toBeNull();
    expect(checkSpendCap(MAX_SPEND_CAP + 1)).toBe("invalid_cap");
  });
});

describe("whether a month is still inside its cap", () => {
  it("lets every unit through when no cap is set", () => {
    // What every workspace from before caps existed has: the add-on they are
    // paying for goes on working.
    expect(withinSpendCap(0, UNCAPPED)).toBe(true);
    expect(withinSpendCap(1_000_000_000, UNCAPPED)).toBe(true);
  });

  it("allows the units up to the cap, and refuses the one past it", () => {
    expect(withinSpendCap(499, 500)).toBe(true);
    expect(withinSpendCap(500, 500)).toBe(true);
    expect(withinSpendCap(501, 500)).toBe(false);
  });

  it("still allows everything inside the quota under a cap of zero", () => {
    // Nothing past the quota, so nothing to bill: the plan paid for these, and a
    // cap of zero is about the add-on rather than about the plan.
    expect(withinSpendCap(0, 0)).toBe(true);
    expect(withinSpendCap(1, 0)).toBe(false);
  });
});

describe("what a capped month may be billed", () => {
  it("bills the whole figure when it is inside the cap", () => {
    expect(billableOverageUnits(300, 500)).toBe(300);
    expect(billableOverageUnits(500, 500)).toBe(500);
  });

  // The guarantee. The counter counts the calls the route refused, so a month
  // that ran into its ceiling ends above it; reporting the raw difference would
  // invoice for exactly the units the cap was set to prevent.
  it("never bills past the cap, however far the counter ran", () => {
    expect(billableOverageUnits(501, 500)).toBe(500);
    expect(billableOverageUnits(10_000, 500)).toBe(500);
  });

  it("bills nothing at all under a cap of zero", () => {
    expect(billableOverageUnits(9_000, 0)).toBe(0);
  });

  it("bills the whole figure when no cap is set", () => {
    expect(billableOverageUnits(9_000, UNCAPPED)).toBe(9_000);
  });
});
