/**
 * What a tenant is allowed to do.
 *
 * Entitlements are DERIVED from (plan, subscription status) on every read —
 * never copied onto the tenant row. A stored copy is a second source of truth
 * that silently goes stale the moment a webhook is missed, which is exactly how
 * cancelled customers keep paid access.
 */

import type { Currency } from "./currency";
import { MIN_SEATS } from "./seats";

export const FEATURES = ["assistant", "export", "api", "sso"] as const;
export type Feature = (typeof FEATURES)[number];

export const PLANS = {
  free: {
    name: "Free",
    prices: { usd: 0, vnd: 0 },
    features: ["assistant"] as Feature[],
    quotas: { aiMessages: 50 },
    trialDays: 0,
    // Free stops at its quota rather than billing past it: there is no
    // subscription behind it for a usage record to attach to, so a message
    // beyond the fiftieth could only be given away or refused.
    meteredOverage: false,
  },
  pro: {
    name: "Pro",
    prices: { usd: 1_900, vnd: 490_000 },
    features: ["assistant", "export", "api"] as Feature[],
    quotas: { aiMessages: 2_000 },
    trialDays: 14,
    meteredOverage: true,
  },
  scale: {
    name: "Scale",
    prices: { usd: 9_900, vnd: 2_490_000 },
    features: ["assistant", "export", "api", "sso"] as Feature[],
    quotas: { aiMessages: 20_000 },
    trialDays: 14,
    meteredOverage: true,
  },
} as const;

export type PlanKey = keyof typeof PLANS;
export type QuotaKey = keyof (typeof PLANS)["free"]["quotas"];

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && value in PLANS;
}

/**
 * What a plan costs in `currency`, in that currency's minor unit.
 *
 * A price per currency rather than one amount converted on read: a rate that
 * moves would reprice the catalogue between the page a customer read and the
 * invoice they are sent, and a price list is a round number somebody chose
 * rather than today's arithmetic. The compiler is what keeps the table whole —
 * a plan missing a currency, or a currency added without a price on every
 * plan, is a type error here rather than a free Scale subscription.
 */
export function priceMinorFor(planKey: PlanKey, currency: Currency): number {
  return PLANS[planKey].prices[currency];
}

/**
 * How long a trial on this plan runs, in days. Zero means no trial, which is
 * also the answer for a plan we no longer sell: a trial has to be asked for at
 * checkout, and nothing can ask for one on a plan that is not there.
 */
export function trialDaysFor(planKey: string): number {
  return isPlanKey(planKey) ? PLANS[planKey].trialDays : 0;
}

/**
 * Does this plan bill what is used beyond its quota, rather than refusing it?
 * `false` for a plan we no longer sell, the way `trialDaysFor` answers zero:
 * the add-on is bought at checkout, and nothing can buy one on a plan that is
 * not there.
 */
export function sellsMeteredOverage(planKey: string): boolean {
  return isPlanKey(planKey) && PLANS[planKey].meteredOverage;
}

export interface Entitlements {
  planKey: PlanKey;
  /**
   * Seats paid for: how many people may hold one. Features and quotas are the
   * workspace's rather than each seat's, so buying a seat buys a person access
   * and not another month's worth of messages.
   */
  seats: number;
  features: readonly Feature[];
  quotas: Readonly<Record<QuotaKey, number>>;
  /**
   * Whether the quota above is a threshold rather than a ceiling: usage beyond
   * it goes through and is billed as a metered add-on. An entitlement like
   * every other here, so it ends when the subscription paying for it does.
   */
  meteredOverage: boolean;
}

/**
 * PAST_DUE keeps paid access on purpose: a card that failed its renewal is a
 * dunning problem, not a reason to lock someone out mid-month. TRIALING is the
 * plan and not a preview of it — a trial exists to show the customer what they
 * would be buying, so the day it converts nothing about their access changes,
 * and the thing they were evaluating is the thing they had. Every other
 * non-active status falls back to Free.
 */
const STATUSES_WITH_PAID_ACCESS = new Set(["ACTIVE", "TRIALING", "PAST_DUE"]);

/**
 * Which of those may also run up a bill beyond the quota. TRIALING is
 * deliberately not one: a trial takes no money, and one that ends with an
 * invoice for the messages it was spent judging the product on is not a trial
 * — so the quota is where a trial stops. PAST_DUE is one, because it keeps paid
 * access on purpose: the usage happens, and a renewal that failed is a reason
 * to write to the customer rather than a reason to hand them the month free.
 */
const STATUSES_THAT_BILL_OVERAGE = new Set(["ACTIVE", "PAST_DUE"]);

export function entitlementsFor(
  planKey: string,
  status: string,
  seats = MIN_SEATS,
  /** Whether the subscription was bought with the metered add-on. */
  meteredOverage = false,
): Entitlements {
  const paid = isPlanKey(planKey) && STATUSES_WITH_PAID_ACCESS.has(status);
  const effective: PlanKey = paid ? planKey : "free";
  const plan = PLANS[effective];
  return {
    planKey: effective,
    // Seats are derived exactly like the plan is, and for the same reason: a
    // count left standing after the subscription ended is paid access nobody
    // is paying for. What survives is the one seat the owner holds.
    seats: paid ? Math.max(MIN_SEATS, seats) : MIN_SEATS,
    features: plan.features,
    quotas: plan.quotas,
    // Three things have to agree before a quota becomes a threshold: the plan
    // sells the add-on, the subscription was bought with one, and the status is
    // one the gateway will still invoice. Anything else is a ceiling — usage
    // nobody will be charged for must not be usage we let through.
    meteredOverage:
      plan.meteredOverage && meteredOverage && STATUSES_THAT_BILL_OVERAGE.has(status),
  };
}

export function canUse(entitlements: Entitlements, feature: Feature): boolean {
  return entitlements.features.includes(feature);
}

export function quotaFor(entitlements: Entitlements, quota: QuotaKey): number {
  return entitlements.quotas[quota];
}

export function remaining(entitlements: Entitlements, quota: QuotaKey, used: number): number {
  return Math.max(0, quotaFor(entitlements, quota) - used);
}
