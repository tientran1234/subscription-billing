/**
 * How the app under test is run.
 *
 * The Playwright config starts the server with these; the specs sign webhooks
 * with the same secret. One module both sides import, because a suite and the
 * server it drives disagreeing about a secret fails as a bad signature, which
 * reads like a bug in the code under test rather than in the harness.
 */

export const PORT = Number(process.env.E2E_PORT ?? 3100);
export const BASE_URL = `http://localhost:${PORT}`;

/**
 * Deliberately worthless credentials. `BILLING_PROVIDER=fake` means nothing
 * here is ever sent to Stripe, and a real test key would only be a real test
 * key sitting in a repository.
 */
export const APP_ENV: Record<string, string> = {
  BILLING_PROVIDER: "fake",
  STRIPE_SECRET_KEY: "sk_test_e2e",
  STRIPE_WEBHOOK_SECRET: "whsec_e2e",
  STRIPE_PRICE_PRO: "price_e2e_pro",
  STRIPE_PRICE_SCALE: "price_e2e_scale",
  APP_URL: BASE_URL,
  // Auth.js parses these before it will answer at all, even though the suite
  // writes its own session rows and never sends a magic link.
  AUTH_SECRET: "e2e-only-not-a-secret",
  EMAIL_SERVER: "smtp://localhost:1025",
  EMAIL_FROM: "billing@example.test",
};
