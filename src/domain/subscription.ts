/**
 * Subscription status: a forward-only state machine.
 *
 * Declared once here, then enforced a second time in the database (see
 * `applyEvent` in src/server/billing.service.ts, which updates WHERE status IN
 * (allowed predecessors)). Two webhook deliveries racing each other can both
 * pass the check here; only one can win the conditional UPDATE.
 */

import type { BillingEventType } from "./billing-event.js";

export const SUBSCRIPTION_STATUSES = [
  "PENDING",
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
  "EXPIRED",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

const ALLOWED: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  PENDING: ["TRIALING", "ACTIVE", "EXPIRED"],
  // A trial ends exactly once, and every way out of it is forward: the first
  // invoice is paid, it is not, the customer leaves, or the provider gives up.
  // Nothing re-enters it — ACTIVE → TRIALING would hand a paying customer a
  // second free month, and TRIALING → TRIALING is what makes a replayed trial
  // start a no-op in Postgres rather than only in Node.
  TRIALING: ["ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED"],
  ACTIVE: ["PAST_DUE", "CANCELED"],
  // Dunning: a failed renewal can recover, be cancelled, or run out of retries.
  PAST_DUE: ["ACTIVE", "CANCELED", "EXPIRED"],
  CANCELED: [],
  EXPIRED: [],
};

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

/** Every status allowed to move INTO `to` — this builds the SQL WHERE clause. */
export function predecessorsOf(to: SubscriptionStatus): SubscriptionStatus[] {
  return SUBSCRIPTION_STATUSES.filter((from) => canTransition(from, to));
}

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

/** Map a normalized provider event to the status it should produce. */
export function statusForEvent(type: BillingEventType): SubscriptionStatus | null {
  switch (type) {
    case "subscription_activated":
      return "ACTIVE";
    case "subscription_trialing":
      return "TRIALING";
    // Deliberately no status. The trial running out is not itself a change —
    // what follows it is, and that arrives as its own event: an invoice paid,
    // or one that fails. Mapping it to a status here would mean guessing which
    // of the two happened before the provider has said.
    case "trial_ending":
      return null;
    case "payment_failed":
      return "PAST_DUE";
    case "subscription_canceled":
      return "CANCELED";
    case "subscription_expired":
      return "EXPIRED";
    default:
      return null; // unknown event — record it, change nothing
  }
}
