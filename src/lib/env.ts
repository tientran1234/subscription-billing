import { z } from "zod";

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
  APP_URL: z.string().url(),
});

/**
 * Auth settings are parsed separately so a missing SMTP host breaks sign-in
 * only, and not checkout or the webhook route that never look at it.
 */
const authSchema = z.object({
  AUTH_SECRET: z.string().min(1),
  /** SMTP connection string, e.g. smtp://user:pass@host:587 */
  EMAIL_SERVER: z.string().min(1),
  EMAIL_FROM: z.string().email(),
});

let cached: z.infer<typeof schema> | null = null;
let cachedAuth: z.infer<typeof authSchema> | null = null;

export function env() {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export function authEnv() {
  if (!cachedAuth) cachedAuth = authSchema.parse(process.env);
  return cachedAuth;
}

/** Provider-side price id for a plan. Free has no price — it never checks out. */
export function priceRefFor(planKey: string): string | null {
  const e = env();
  if (planKey === "pro") return e.STRIPE_PRICE_PRO;
  if (planKey === "scale") return e.STRIPE_PRICE_SCALE;
  return null;
}
