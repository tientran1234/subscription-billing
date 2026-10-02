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
 * `planKey` is allowed to move after checkout, and `seatsForPaidInvoice` the
 * only place `seats` is.
 */

import { PLANS, isPlanKey, type PlanKey } from "./entitlements";
import { checkSeats, isSellableSeatCount, type SeatRefusal } from "./seats";

export type PlanChangeRefusal =
  /** Not a plan we sell. */
  | "unknown_plan"
  /** Free has no price to move to — leaving a paid plan is a cancellation. */
  | "not_purchasable"
  /** Nothing is being billed right now, so there is nothing to prorate. */
  | "not_billable"
  /** Already on it, at that many seats. */
  | "same_plan"
  /** The seat count itself is refused — see src/domain/seats.ts. */
  | SeatRefusal;

/**
 * What the tenant has now, and what a change would be measured against. Seats
 * in use belong here rather than being passed alongside: the floor is a fact
 * about the workspace at this instant, the same way its status is.
 */
export interface CurrentPlan {
  planKey: string;
  status: string;
  seats: number;
  /** Seats occupied right now — the floor a change may not go below. */
  seatsInUse: number;
}

export type PlanChangeCheck =
  | { ok: true; planKey: PlanKey; seats: number }
  | { ok: false; reason: PlanChangeRefusal };

/**
 * ACTIVE and nothing else. PENDING has never been paid for, so there is no
 * price to prorate against; PAST_DUE has an invoice still outstanding and
 * charging a proration on top of it is how customers end up owing two amounts
 * for one month; CANCELED and EXPIRED are over. A tenant in any of those
 * subscribes again rather than changing plan.
 *
 * `target.seats` omitted means the seat count stays where it is, so a plan move
 * carries the seats across rather than quietly reselling one.
 */
export function checkPlanChange(
  current: CurrentPlan,
  target: { planKey: string; seats?: number },
): PlanChangeCheck {
  const seats = target.seats ?? current.seats;
  if (!isPlanKey(target.planKey)) return { ok: false, reason: "unknown_plan" };
  if (target.planKey === "free") return { ok: false, reason: "not_purchasable" };
  if (current.status !== "ACTIVE") return { ok: false, reason: "not_billable" };

  const seatRefusal = checkSeats(seats, current.seatsInUse);
  if (seatRefusal) return { ok: false, reason: seatRefusal };

  // Seats are part of what is bought, so moving them on the plan the tenant is
  // already on is a real change: there is a proration to quote and an invoice
  // to raise. Only both unchanged is nothing to do.
  if (current.planKey === target.planKey && seats === current.seats) {
    return { ok: false, reason: "same_plan" };
  }
  return { ok: true, planKey: target.planKey, seats };
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
 *
 * `seats` is what the customer has asked for, which is why it is a parameter
 * rather than read off `current`: the answers move as they change the number,
 * and the plan they are already on becomes offerable the moment it differs.
 */
export function planChangeOptions(
  current: CurrentPlan,
  seats = current.seats,
): PlanChangeOption[] {
  return (Object.keys(PLANS) as PlanKey[]).map((planKey) => {
    const check = checkPlanChange(current, { planKey, seats });
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
 * Whether a paid invoice is evidence about the period we are in, or about one
 * already behind us.
 *
 * Webhooks arrive out of order, so a renewal raised before an upgrade but
 * delivered after it must not undo the change it predates. With no period end
 * on either side there is nothing to order the two by, so the invoice is taken
 * at its word.
 */
function isCurrentInvoice(
  stored: { currentPeriodEnd: Date | null },
  event: { currentPeriodEnd?: Date },
): boolean {
  if (!stored.currentPeriodEnd || !event.currentPeriodEnd) return true;
  return event.currentPeriodEnd >= stored.currentPeriodEnd;
}

/**
 * The plan a paid invoice moves the subscription to, or `null` to leave it
 * alone.
 *
 * The invoice carries the plan that was in force when it was finalized, which
 * is what makes it evidence: the money for that plan has been taken. A plan we
 * cannot price is refused anyway, because entitlements would fall back to Free
 * and the tenant would lose the access they just paid for.
 */
export function planKeyForPaidInvoice(
  stored: { planKey: string; currentPeriodEnd: Date | null },
  event: { planKey?: string; currentPeriodEnd?: Date },
): PlanKey | null {
  if (!event.planKey || !isPlanKey(event.planKey)) return null;
  if (event.planKey === stored.planKey) return null;
  if (!isCurrentInvoice(stored, event)) return null;
  return event.planKey;
}

/**
 * The seat count a paid invoice moves the subscription to, or `null` to leave
 * it alone.
 *
 * Seats arrive the way the plan does, and are evidence for the same reason: the
 * quantity on the invoice is the quantity the money was taken for. The
 * occupancy floor is deliberately not applied here — it guards what a customer
 * may ask to buy, and by this point they have bought it; refusing the count
 * would leave them paying for seats their workspace does not have. A count we
 * cannot sell at all is refused, because a zero or a thousand on an invoice
 * line is a reason to go and look rather than to write.
 */
export function seatsForPaidInvoice(
  stored: { seats: number; currentPeriodEnd: Date | null },
  event: { seats?: number; currentPeriodEnd?: Date },
): number | null {
  if (event.seats === undefined || !isSellableSeatCount(event.seats)) return null;
  if (event.seats === stored.seats) return null;
  if (!isCurrentInvoice(stored, event)) return null;
  return event.seats;
}
