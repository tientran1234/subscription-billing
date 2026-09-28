import { defineConfig } from "@playwright/test";
import { APP_ENV, BASE_URL, PORT } from "./tests/e2e/app";

/**
 * End-to-end: a real Next server, a real Postgres, the real routes, driven
 * through a browser. Only the payment gateway is swapped for the in-memory
 * adapter — CI has no Stripe account, and the guarantees being checked here
 * (a checkout becoming access, a replay changing nothing, access ending with
 * the subscription) are this application's, not Stripe's.
 *
 * Needs a database, like the integration tests: `pnpm db:up && pnpm db:push`.
 */
export default defineConfig({
  testDir: "./tests/e2e",

  // One worker over one Postgres, for the reason vitest runs its files
  // serially: tests that wiped each other's rows mid-flight would fail in
  // whichever order they happened to interleave.
  workers: 1,
  fullyParallel: false,

  // No retries. A billing test that passes on the second go has found
  // something, and hiding it is the opposite of why this suite exists.
  retries: 0,
  forbidOnly: Boolean(process.env.CI),

  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },

  webServer: {
    // Dev mode, not a production build: the fake gateway is refused when
    // NODE_ENV is production, which is exactly the guard worth keeping.
    command: `pnpm exec next dev --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: APP_ENV,
  },
});
