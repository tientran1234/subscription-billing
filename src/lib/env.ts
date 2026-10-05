import { z } from "zod";
import { sellsMeteredOverage } from "@/domain/entitlements";

/**
 * Parsed lazily, not at module load: `next build` runs without secrets, and a
 * crash at import time would break the build instead of the one request that
 * actually needs the value.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_PRO: z.string().min(1),
  STRIPE_PRICE_SCALE: z.string().min(1),
  STRIPE_PRICE_OVERAGE: z.string().min(1),
  APP_URL: z.string().url(),
});

/**
 * Where mail goes out. Magic links and dunning notices share one SMTP url
 * because they are one application writing to one customer; splitting them
 * would be two settings to keep in step for no gain.
 */
const mailSchema = z.object({
  /** SMTP connection string, e.g. smtp://user:pass@host:587 */
  EMAIL_SERVER: z.string().min(1),
  EMAIL_FROM: z.string().email(),
});

/**
 * Auth settings are parsed separately so a missing SMTP host breaks sign-in
 * only, and not checkout or the webhook route that never look at it.
 */
const authSchema = mailSchema.extend({
  AUTH_SECRET: z.string().min(1),
});

let cached: z.infer<typeof schema> | null = null;
let cachedAuth: z.infer<typeof authSchema> | null = null;
let cachedMail: z.infer<typeof mailSchema> | null = null;

export function env() {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export function authEnv() {
  if (!cachedAuth) cachedAuth = authSchema.parse(process.env);
  return cachedAuth;
}

export function mailEnv() {
  if (!cachedMail) cachedMail = mailSchema.parse(process.env);
  return cachedMail;
}

/** Provider-side price id for a plan. Free has no price — it never checks out. */
export function priceRefFor(planKey: string): string | null {
  const e = env();
  if (planKey === "pro") return e.STRIPE_PRICE_PRO;
  if (planKey === "scale") return e.STRIPE_PRICE_SCALE;
  return null;
}

/**
 * Provider-side price id for the metered add-on, or null for a plan that stops
 * at its quota.
 *
 * One metered price for the deployment rather than one per plan: a message past
 * the allowance costs the same whichever allowance ran out, and a single price
 * means a plan change moves the licensed item without having to swap the meter
 * beside it — which would strand the usage already reported against the old
 * one. Which plans sell it is still the plan's own answer, so the catalogue in
 * src/domain/entitlements.ts stays the one place that says what we sell.
 */
export function overagePriceRefFor(planKey: string): string | null {
  return sellsMeteredOverage(planKey) ? env().STRIPE_PRICE_OVERAGE : null;
}
