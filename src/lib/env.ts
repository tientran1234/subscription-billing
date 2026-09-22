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

let cached: z.infer<typeof schema> | null = null;

export function env() {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

/** Provider-side price id for a plan. Free has no price — it never checks out. */
export function priceRefFor(planKey: string): string | null {
  const e = env();
  if (planKey === "pro") return e.STRIPE_PRICE_PRO;
  if (planKey === "scale") return e.STRIPE_PRICE_SCALE;
  return null;
}
