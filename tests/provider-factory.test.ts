/**
 * Which adapter the routes get. The default matters more than the switch: an
 * app that reached for the in-memory gateway whenever a variable was missing
 * would be one unset environment away from giving paid features to everyone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeProvider } from "@/providers/fake";
import { StripeProvider } from "@/providers/stripe";
import { billingProvider } from "@/providers";

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://x/y",
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_SCALE: "price_scale",
  APP_URL: "http://localhost:3000",
});

const nodeEnv = process.env.NODE_ENV;

afterEach(() => {
  delete process.env.BILLING_PROVIDER;
  Object.assign(process.env, { NODE_ENV: nodeEnv });
});

describe("provider factory", () => {
  it("hands out the real gateway when nothing asks otherwise", () => {
    expect(billingProvider()).toBeInstanceOf(StripeProvider);
  });

  it("hands out the real gateway for any value that is not `fake`", () => {
    process.env.BILLING_PROVIDER = "stripe";
    expect(billingProvider()).toBeInstanceOf(StripeProvider);

    process.env.BILLING_PROVIDER = "";
    expect(billingProvider()).toBeInstanceOf(StripeProvider);
  });

  it("hands out the in-memory gateway only when asked for it by name", () => {
    process.env.BILLING_PROVIDER = "fake";
    expect(billingProvider()).toBeInstanceOf(FakeProvider);
  });

  // The fake signs its own webhooks and invents its own checkout urls, so a
  // production deployment that reached it would accept anybody's events.
  it("refuses the in-memory gateway in production", () => {
    Object.assign(process.env, { NODE_ENV: "production", BILLING_PROVIDER: "fake" });
    expect(() => billingProvider()).toThrow(/production/);
  });

  // One secret, whichever gateway is wired up: the webhook route reads
  // STRIPE_WEBHOOK_SECRET and has nothing to switch on.
  it("verifies fake webhooks against the same secret Stripe's are", async () => {
    process.env.BILLING_PROVIDER = "fake";
    const provider = billingProvider();
    const body = JSON.stringify({ providerEventId: "evt_1", type: "subscription_activated" });

    const signed = new FakeProvider("whsec_x").sign(body);
    await expect(provider.verifyWebhook(body, signed)).resolves.toMatchObject({
      providerEventId: "evt_1",
    });
  });
});
