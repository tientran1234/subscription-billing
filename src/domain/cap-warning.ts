/**
 * Which warning a month of overage has earned: that its ceiling is close, or
 * that it has been reached.
 *
 * Pure — no I/O — like the rest of this directory, so the route that refuses a
 * call and the notice that writes to the customer read one rule rather than
 * each deciding what "close" means.
 *
 * A cap that holds silently is a cap that surprises. The ceiling is a figure
 * the customer set once and the account page is the only place that repeats it,
 * so the first they hear of it is a key that has stopped working — and the
 * month's own usage is what says when to tell them. Hence a line below the cap
 * as well as the cap itself: one mail while the add-on is still serving calls
 * and something can be done about it, one when it has stopped.
 *
 * Measured in units past the quota, exactly as the cap is (see
 * src/domain/spend-cap.ts). A warning in money would need the catalogue price
 * the customer never sees, and would move the line the day that price moved.
 *
 * What this file does not decide is how often the mail goes out. A rule from a
 * counter is true for every call that follows it — the four-hundredth message
 * of five hundred is still past the line at the four-hundred-and-first — so
 * "once per month" cannot come from here. It is a claim per (workspace, month,
 * kind) in src/server/cap-warning.ts, the way a dunning notice claims an event
 * id.
 */

import { UNCAPPED, withinSpendCap, type SpendCap } from "./spend-cap";

export const CAP_WARNING_KINDS = ["approaching", "reached"] as const;

export type CapWarningKind = (typeof CAP_WARNING_KINDS)[number];

/**
 * Where the first mail goes out for a workspace that has not said otherwise.
 *
 * A fraction of the ceiling rather than a fixed number of units, because a
 * workspace that capped itself at fifty messages and one that capped itself at
 * fifty thousand are the same distance from trouble at the same fraction, and
 * any fixed figure is either most of the first cap or a rounding error in the
 * second.
 */
export const DEFAULT_CAP_WARNING_PCT = 80;

/**
 * Where a workspace asked to be written to, in percent of its ceiling, or
 * `null` for one that has never said.
 *
 * Null is not a zero, the way an unset cap is not a cap of zero: it is the
 * absence of an answer, and {@link capWarningPct} is the rule that turns it
 * into a line. Every workspace from before this setting carries it.
 */
export type CapWarningAt = number | null;

/**
 * Below this a warning is noise — a line at nothing warns on the first unit
 * past the quota, which is what a cap of zero already says on its own.
 */
export const MIN_CAP_WARNING_PCT = 1;

/**
 * At a hundred the two mails are one: `approaching` would land on the unit
 * that is already being refused, so the warning a customer set out to get —
 * one while something can still be done — would never be sent at all.
 */
export const MAX_CAP_WARNING_PCT = 99;

export type CapWarningAtRefusal =
  /** Not a whole percent, or outside the bounds above. */
  | "invalid_warning_at";

/**
 * Whether `at` is a line a workspace may ask for. `null` is, and means the
 * default.
 */
export function checkCapWarningAt(at: CapWarningAt): CapWarningAtRefusal | null {
  if (at === null) return null;
  if (!Number.isInteger(at) || at < MIN_CAP_WARNING_PCT || at > MAX_CAP_WARNING_PCT) {
    return "invalid_warning_at";
  }
  return null;
}

/** The line in force for a workspace: the one it picked, or the default. */
export function capWarningPct(at: CapWarningAt): number {
  return at ?? DEFAULT_CAP_WARNING_PCT;
}

/**
 * The first unit that earns an `approaching` notice under `cap`, at the line
 * `at` — or at the default for a workspace that never picked one.
 *
 * Whole percents of the cap rather than a fraction per workspace, so the
 * arithmetic is two integers and a divide: a figure the customer types is
 * stored exactly as they typed it, where a fraction derived from it would be
 * the nearest double to it and would put a line a unit off its neighbour's on
 * the same cap.
 *
 * Rounded up, so the line is "at least that much of the ceiling is gone"
 * rather than "nearly": on a cap small enough for the two to differ, rounding
 * down would warn a customer who has barely started.
 */
export function capWarningThreshold(cap: number, at: CapWarningAt = null): number {
  return Math.ceil((cap * capWarningPct(at)) / 100);
}

/**
 * Which notice a month that has run `units` past its quota has earned under
 * `cap`, or `null` for silence.
 *
 * Asked after `meter` has counted the call and after the cap has been checked,
 * so `reached` means the unit just taken is one the customer will not be billed
 * for and will not be served either — the refusal and the mail about it are the
 * same moment, which is the point of saying it here rather than from the job
 * that bills the month a fortnight later.
 *
 * An uncapped workspace is silent because it has no ceiling to approach, and a
 * month still inside its allowance is silent because the plan has already paid
 * for every unit of it: a cap is about the add-on, and nothing has been added
 * on yet. Note that `approaching` is not a prerequisite for `reached` — a
 * ceiling lowered under a month that has already passed it, or one request
 * metering several units at once, goes straight to the second — because a
 * warning about what is about to happen is not worth sending after it has.
 */
export function capWarningFor(
  units: number,
  cap: SpendCap,
  at: CapWarningAt = null,
): CapWarningKind | null {
  if (cap === UNCAPPED || units <= 0) return null;
  if (!withinSpendCap(units, cap)) return "reached";
  return units >= capWarningThreshold(cap, at) ? "approaching" : null;
}
