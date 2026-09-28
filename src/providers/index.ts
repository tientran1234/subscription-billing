/**
 * Which adapter the app talks to.
 *
 * Stripe unless `BILLING_PROVIDER` says otherwise, because a gateway chosen by
 * an environment variable that is usually absent should choose the real one.
 * `fake` is refused once NODE_ENV is production: that adapter answers every
 * call from memory, so a deployment misconfigured into it would hand out
 * checkout urls nobody can pay and accept webhooks anyone can sign.
 *
 * The end-to-end suite is what this exists for. It drives checkout, the
 * webhook and the entitlement drop through the real routes in a real browser,
 * and there is no Stripe account behind CI to drive them against.
 */
import type { IBillingProvider } from "@/domain/billing-event";
import { env } from "@/lib/env";
import { FakeProvider } from "./fake";
import { StripeProvider } from "./stripe";

export function billingProvider(): IBillingProvider {
  const e = env();

  if (process.env.BILLING_PROVIDER === "fake") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("BILLING_PROVIDER=fake is refused in production");
    }
    // Signed with the same secret Stripe's webhooks are verified against, so
    // swapping the gateway is one variable and the webhook route still reads
    // its secret from exactly one place.
    return new FakeProvider(e.STRIPE_WEBHOOK_SECRET);
  }

  return new StripeProvider(e.STRIPE_SECRET_KEY, e.STRIPE_WEBHOOK_SECRET);
}
