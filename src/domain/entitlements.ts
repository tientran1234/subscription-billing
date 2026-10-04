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
  },
  pro: {
    name: "Pro",
    prices: { usd: 1_900, vnd: 490_000 },
    features: ["assistant", "export", "api"] as Feature[],
    quotas: { aiMessages: 2_000 },
    trialDays: 14,
  },
  scale: {
    name: "Scale",
    prices: { usd: 9_900, vnd: 2_490_000 },
    features: ["assistant", "export", "api", "sso"] as Feature[],
    quotas: { aiMessages: 20_000 },
    trialDays: 14,
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

export function entitlementsFor(
  planKey: string,
  status: string,
  seats = MIN_SEATS,
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
