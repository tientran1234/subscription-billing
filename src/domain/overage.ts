/**
 * Usage past the plan's quota: how much of it is billable, and when it may be
 * reported.
 *
 * Pure — no I/O — like the rest of this directory, so the rule that decides
 * what a customer owes for a month runs in the job, in the route and in a test
 * off the same answer.
 *
 * A quota is either a ceiling or a threshold, and which one it is belongs to
 * the plan: Free stops at fifty messages because there is no subscription to
 * attach a usage record to, while a plan that sells the add-on bills what is
 * used beyond its own allowance instead of refusing the call. Only the units
 * past the quota are ever reported — everything up to it has already been paid
 * for by the plan, so sending the raw counter would charge twice for the same
 * messages.
 *
 * A quota that is a threshold still has a ceiling where the workspace put one.
 * A cap belongs to the customer rather than to the plan, so it does not change
 * what is owed past the quota — it changes how much of that is billable, which
 * is why it arrives here as a figure to clamp against and lives in
 * src/domain/spend-cap.ts.
 *
 * The part worth naming is the period. A month is reported once, because the
 * claim that makes the report idempotent is keyed by the month — so reporting
 * one that is still accruing would spend that single report on a partial
 * figure, and every message sent for the rest of the month would have nowhere
 * left to go. A period is therefore reported only once it has closed, and a
 * closed period's counter cannot move again, which is what makes the figure
 * worth claiming: the number this rule computes for a closed month is the same
 * number whenever it is computed.
 */

import type { QuotaKey } from "./entitlements";
import { billableOverageUnits, type SpendCap } from "./spend-cap";

/**
 * The one quota sold beyond the plan. It is the counter `meter` increments and
 * the counter the job reads, named once here so a report cannot be raised
 * against a bucket nothing fills.
 */
export const OVERAGE_QUOTA: QuotaKey = "aiMessages";

/**
 * Units past the quota. Never negative: a month inside the allowance owes
 * nothing, and a negative quantity is a credit nobody asked us to issue.
 */
export function overageUnits(used: number, limit: number): number {
  return Math.max(0, used - limit);
}

/**
 * Has `period` finished, as of the month the clock is in?
 *
 * A string comparison, because `YYYY-MM` sorts the way the calendar does and
 * the arithmetic that would otherwise be needed here is the arithmetic that is
 * wrong every December. The current month is passed in rather than read off a
 * clock so this stays pure, the way `parsePeriod` takes its fallback.
 */
export function isPeriodClosed(period: string, currentPeriod: string): boolean {
  return period < currentPeriod;
}

export type OverageRefusal =
  /** The month is still accruing, so there is no final figure to bill. */
  | "period_open"
  /** This subscription's quota is a ceiling: the calls were refused, not billed. */
  | "not_metered"
  /** Inside the allowance — the plan has already paid for every unit. */
  | "no_overage"
  /** The workspace's own ceiling is zero, so none of the month is billable. */
  | "capped";

export interface OverageSubject {
  /**
   * Whether the quota is a threshold rather than a ceiling. Derived from the
   * subscription by `entitlementsFor`, never stored, so a workspace that has
   * stopped paying stops accruing a bill the same instant its access ends.
   */
  meteredOverage: boolean;
  /** Units metered in the period, as `meter` counted them. */
  used: number;
  /** What the plan includes in a month. */
  limit: number;
  /**
   * The ceiling this workspace set on what it will be billed past the quota.
   * Applied here and not only where calls are refused: the counter counted
   * those refusals too, so this is what decides what the invoice says.
   */
  cap: SpendCap;
  /** The month being reported. */
  period: string;
  /** The month the clock is in. */
  currentPeriod: string;
}

export type OverageCheck =
  | { ok: true; units: number }
  | { ok: false; reason: OverageRefusal };

/**
 * Whether this subscription owes anything for `period`, and how much.
 *
 * The order of the refusals is deliberate: an open month is refused before
 * anything about the subscription is looked at, because the answer for one is
 * "not yet" rather than "nothing" — a caller that treated a month still running
 * as nothing owing would record it as reported and bill none of it. The cap is
 * applied last, on a figure that is already final, because it is the only one
 * of them that is a decision the customer made rather than a fact about what
 * they used.
 */
export function checkOverage(subject: OverageSubject): OverageCheck {
  if (!isPeriodClosed(subject.period, subject.currentPeriod)) {
    return { ok: false, reason: "period_open" };
  }
  if (!subject.meteredOverage) return { ok: false, reason: "not_metered" };

  const used = overageUnits(subject.used, subject.limit);
  const units = billableOverageUnits(used, subject.cap);
  // Which nothing it is matters to whoever reads the outcome: a month inside the
  // allowance never cost anything, while one clamped flat ran into a ceiling its
  // own customer set, and the usage behind it was refused at the time.
  if (units === 0) return { ok: false, reason: used > 0 ? "capped" : "no_overage" };
  return { ok: true, units };
}
