/**
 * The ceiling a workspace sets on its own metered add-on: how far past the
 * plan's quota it is willing to be billed.
 *
 * Pure — no I/O — like the rest of this directory, so the route that refuses a
 * call and the job that bills the month read one rule rather than each deciding
 * what a cap means.
 *
 * A cap counts units past the quota, not money. Units are the figure this
 * application owns: `meter` counts them, the report carries them, and the
 * account page can state the ceiling without fetching anything. What a unit
 * costs is on a price in the gateway's catalogue, so a cap in money would have
 * to be divided by a figure the customer never sees — and would quietly buy
 * them fewer messages the day that price moved, which is not what anybody means
 * by setting a limit.
 *
 * The cap holds in two places or it holds in neither. The route refuses the
 * call that would take the month past it, and the job clamps what it reports,
 * because the counter goes on counting the calls the route refused: a month
 * that ran into its cap ends with a counter above it, and reporting
 * `used - limit` would invoice for exactly the units the cap was set to
 * prevent. The clamp is the half that is about money, so it is the half that
 * has to hold even when the route is wrong.
 */

/**
 * Billed for whatever the month runs to. The default, and what every workspace
 * from before caps existed carries: a cap nobody has set is not a cap of zero,
 * which would stop the add-on those customers are paying for.
 */
export const UNCAPPED = null;

/** A ceiling in units past the quota, or {@link UNCAPPED} for none. */
export type SpendCap = number | null;

/**
 * An upper bound, so a slip in a number field cannot set a ceiling no invoice
 * would ever reach — the same reason seats have a maximum. A workspace that
 * genuinely wants more than this wants no cap, and can say so.
 */
export const MAX_SPEND_CAP = 1_000_000;

export type SpendCapRefusal =
  /** Not a whole number of units, negative, or past the bound above. */
  | "invalid_cap";

/**
 * Whether `cap` is a ceiling a workspace may set. `null` is, and means no cap.
 *
 * Zero is one of them, on purpose: a customer who wants their quota to stop
 * being a threshold is asking for precisely that, and the alternative — telling
 * them to drop the add-on in the gateway's portal — is a trip elsewhere to say
 * something they can say here.
 */
export function checkSpendCap(cap: SpendCap): SpendCapRefusal | null {
  if (cap === UNCAPPED) return null;
  if (!Number.isInteger(cap) || cap < 0 || cap > MAX_SPEND_CAP) return "invalid_cap";
  return null;
}

/**
 * Is a month that has run `units` past its quota still inside `cap`?
 *
 * Takes the units rather than the counter so the one rule about what is past a
 * quota stays in src/domain/overage.ts, and this file stays about the ceiling.
 * Asked after `meter` has counted the call, so the question is whether the unit
 * just taken is one the customer agreed to pay for — which for every unit up to
 * the quota is yes, cap or no cap, because the plan has already paid for those.
 */
export function withinSpendCap(units: number, cap: SpendCap): boolean {
  return cap === UNCAPPED || units <= cap;
}

/**
 * What may be billed for a month that ran `units` past its quota: that figure,
 * never more than the cap.
 *
 * A clamp rather than a refusal. A month that ran past its ceiling is still a
 * month with a bill — the cap IS the bill — and refusing the whole figure
 * because part of it was over would hand the customer everything up to their
 * cap for nothing.
 */
export function billableOverageUnits(units: number, cap: SpendCap): number {
  return cap === UNCAPPED ? units : Math.min(units, cap);
}
