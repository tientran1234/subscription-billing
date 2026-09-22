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
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
  "EXPIRED",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

const ALLOWED: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  PENDING: ["ACTIVE", "EXPIRED"],
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
