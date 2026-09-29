/**
 * When a tenant may move to another plan, and when a quoted price still holds.
 *
 * Pure — no I/O — like the rest of this directory, so the rules about money are
 * written once. Two of them are worth naming here:
 *
 * A quote is a promise about an amount, so it expires. The provider computes a
 * proration as of an instant and charges exactly that amount only if the
 * confirming call names the same instant; a quote the customer sat on all day
 * would bill them for a period that has since moved on.
 *
 * A plan change is not a status change. We ask the provider to move the price;
 * the new plan reaches us the way every other fact does — on a webhook, once
 * the proration invoice is paid. `planKeyForPaidInvoice` is the only place
 * `planKey` is allowed to move after checkout.
 */

import { PLANS, isPlanKey, type PlanKey } from "./entitlements";

export type PlanChangeRefusal =
  /** Not a plan we sell. */
  | "unknown_plan"
  /** Free has no price to move to — leaving a paid plan is a cancellation. */
  | "not_purchasable"
  /** Nothing is being billed right now, so there is nothing to prorate. */
  | "not_billable"
  /** Already on it. */
  | "same_plan";

export type PlanChangeCheck =
  | { ok: true; planKey: PlanKey }
  | { ok: false; reason: PlanChangeRefusal };

/**
 * ACTIVE and nothing else. PENDING has never been paid for, so there is no
 * price to prorate against; PAST_DUE has an invoice still outstanding and
 * charging a proration on top of it is how customers end up owing two amounts
 * for one month; CANCELED and EXPIRED are over. A tenant in any of those
 * subscribes again rather than changing plan.
 */
export function checkPlanChange(
  current: { planKey: string; status: string },
  target: string,
): PlanChangeCheck {
  if (!isPlanKey(target)) return { ok: false, reason: "unknown_plan" };
  if (target === "free") return { ok: false, reason: "not_purchasable" };
  if (current.status !== "ACTIVE") return { ok: false, reason: "not_billable" };
  if (current.planKey === target) return { ok: false, reason: "same_plan" };
  return { ok: true, planKey: target };
}

export interface PlanChangeOption {
  planKey: PlanKey;
  /** The plan the tenant is on now. The picker marks it rather than offering it. */
  current: boolean;
  /** Null when the move is allowed; otherwise why this plan is not on offer. */
  refusal: PlanChangeRefusal | null;
}

/**
 * Every plan we sell, each annotated with whether this tenant may move to it.
 *
 * The picker gets no second opinion: each answer comes from `checkPlanChange`,
 * the function the route already runs, so a plan the page offers is a plan the
 * confirm call accepts. A button that leads to a 409 is worse than a button
 * that was never drawn — the customer is refused for a choice we offered them.
 *
 * Plans come from `PLANS`, so adding one puts it in front of customers without
 * anybody remembering to edit a page.
 */
export function planChangeOptions(current: {
  planKey: string;
  status: string;
}): PlanChangeOption[] {
  return (Object.keys(PLANS) as PlanKey[]).map((planKey) => {
    const check = checkPlanChange(current, planKey);
    return {
      planKey,
      current: planKey === current.planKey,
      refusal: check.ok ? null : check.reason,
    };
  });
}

/** How long a proration quote stays binding. */
export const QUOTE_TTL_SECONDS = 15 * 60;

/**
 * A quote is usable while the provider would still compute the same proration
 * for it. The instant is ours — it is generated when the preview is taken — so
 * one dated in the future did not come from a preview, and one too old would
 * charge for a slice of the month that has already been consumed.
 */
export function isQuoteUsable(
  prorationDate: Date,
  now = new Date(),
  ttlSeconds = QUOTE_TTL_SECONDS,
): boolean {
  const ageSeconds = (now.getTime() - prorationDate.getTime()) / 1000;
  return ageSeconds >= 0 && ageSeconds <= ttlSeconds;
}

/**
 * The plan a paid invoice moves the subscription to, or `null` to leave it
 * alone.
 *
 * The invoice carries the plan that was in force when it was finalized, which
 * is what makes it evidence: the money for that plan has been taken. Two things
 * are refused anyway — a plan we cannot price, because entitlements would fall
 * back to Free and the tenant would lose the access they just paid for, and an
 * invoice older than the period we already know about, because webhooks arrive
 * out of order and a late renewal must not undo a newer upgrade. With no period
 * end on either side there is nothing to order the two by, so the invoice is
 * taken at its word.
 */
export function planKeyForPaidInvoice(
  stored: { planKey: string; currentPeriodEnd: Date | null },
  event: { planKey?: string; currentPeriodEnd?: Date },
): PlanKey | null {
  if (!event.planKey || !isPlanKey(event.planKey)) return null;
  if (event.planKey === stored.planKey) return null;
  if (
    stored.currentPeriodEnd &&
    event.currentPeriodEnd &&
    event.currentPeriodEnd < stored.currentPeriodEnd
  ) {
    return null;
  }
  return event.planKey;
}
