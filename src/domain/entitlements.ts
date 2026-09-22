/**
 * What a tenant is allowed to do.
 *
 * Entitlements are DERIVED from (plan, subscription status) on every read —
 * never copied onto the tenant row. A stored copy is a second source of truth
 * that silently goes stale the moment a webhook is missed, which is exactly how
 * cancelled customers keep paid access.
 */

export const FEATURES = ["assistant", "export", "api", "sso"] as const;
export type Feature = (typeof FEATURES)[number];

export const PLANS = {
  free: {
    name: "Free",
    priceMinor: 0,
    features: ["assistant"] as Feature[],
    quotas: { aiMessages: 50 },
  },
  pro: {
    name: "Pro",
    priceMinor: 1900,
    features: ["assistant", "export", "api"] as Feature[],
    quotas: { aiMessages: 2_000 },
  },
  scale: {
    name: "Scale",
    priceMinor: 9900,
    features: ["assistant", "export", "api", "sso"] as Feature[],
    quotas: { aiMessages: 20_000 },
  },
} as const;

export type PlanKey = keyof typeof PLANS;
export type QuotaKey = keyof (typeof PLANS)["free"]["quotas"];

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && value in PLANS;
}

export interface Entitlements {
  planKey: PlanKey;
  features: readonly Feature[];
  quotas: Readonly<Record<QuotaKey, number>>;
}

/**
 * PAST_DUE keeps paid access on purpose: a card that failed its renewal is a
 * dunning problem, not a reason to lock someone out mid-month. Every other
 * non-active status falls back to Free.
 */
const STATUSES_WITH_PAID_ACCESS = new Set(["ACTIVE", "PAST_DUE"]);

export function entitlementsFor(planKey: string, status: string): Entitlements {
  const effective: PlanKey =
    isPlanKey(planKey) && STATUSES_WITH_PAID_ACCESS.has(status) ? planKey : "free";
  const plan = PLANS[effective];
  return { planKey: effective, features: plan.features, quotas: plan.quotas };
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
