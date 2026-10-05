import { describe, expect, it } from "vitest";
import { PLANS } from "@/domain/entitlements";
import {
  OVERAGE_QUOTA,
  checkOverage,
  isPeriodClosed,
  overageUnits,
} from "@/domain/overage";

const subject = (over: Partial<Parameters<typeof checkOverage>[0]> = {}) =>
  checkOverage({
    meteredOverage: true,
    used: 2_500,
    limit: 2_000,
    period: "2026-09",
    currentPeriod: "2026-10",
    ...over,
  });

describe("overage units", () => {
  it("bills only what was used past the quota", () => {
    // The plan has already been paid for, so reporting the raw counter would
    // charge a second time for every message it includes.
    expect(overageUnits(2_500, 2_000)).toBe(500);
  });

  it("owes nothing for a month inside the allowance, or exactly on it", () => {
    expect(overageUnits(1, 2_000)).toBe(0);
    expect(overageUnits(2_000, 2_000)).toBe(0);
  });

  it("never turns unused quota into a credit", () => {
    expect(overageUnits(0, 2_000)).toBe(0);
  });

  it("meters the quota the plans actually carry", () => {
    // The feature `meter` increments and the quota read back here have to be
    // the same bucket, or a report is raised against a counter nothing fills.
    expect(PLANS.pro.quotas[OVERAGE_QUOTA]).toBeGreaterThan(0);
  });
});

describe("period closing", () => {
  it("treats the month the clock is in as still accruing", () => {
    expect(isPeriodClosed("2026-10", "2026-10")).toBe(false);
  });

  it("closes the month before it", () => {
    expect(isPeriodClosed("2026-09", "2026-10")).toBe(true);
  });

  it("rolls over the end of a year", () => {
    expect(isPeriodClosed("2025-12", "2026-01")).toBe(true);
    expect(isPeriodClosed("2026-01", "2025-12")).toBe(false);
  });

  it("does not close a month that has not started", () => {
    expect(isPeriodClosed("2026-11", "2026-10")).toBe(false);
  });
});

describe("what a closed month owes", () => {
  it("reports the units past the quota", () => {
    expect(subject()).toEqual({ ok: true, units: 500 });
  });

  // The whole reason a month has to close first: the report is claimed once
  // per period, so one raised while the month is still running would spend
  // that claim on a partial figure and bill none of the rest.
  it("refuses a month that is still running before anything else", () => {
    expect(subject({ period: "2026-10" })).toEqual({ ok: false, reason: "period_open" });
    // Even when there is plainly nothing to bill: "not yet" and "nothing" are
    // different answers, and a caller that recorded the second would never
    // come back for the month.
    expect(subject({ period: "2026-10", used: 0 })).toEqual({
      ok: false,
      reason: "period_open",
    });
    expect(subject({ period: "2026-10", meteredOverage: false })).toEqual({
      ok: false,
      reason: "period_open",
    });
  });

  it("bills nothing for a subscription whose quota is a ceiling", () => {
    // Those calls were refused at the time with a 429; billing for them now
    // would charge for messages nobody was allowed to send.
    expect(subject({ meteredOverage: false })).toEqual({ ok: false, reason: "not_metered" });
  });

  it("bills nothing for a month inside the quota", () => {
    expect(subject({ used: 1_999 })).toEqual({ ok: false, reason: "no_overage" });
    expect(subject({ used: 0 })).toEqual({ ok: false, reason: "no_overage" });
  });
});
