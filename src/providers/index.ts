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
import type { IAssistantProvider } from "@/domain/assistant";
import type { IBillingProvider } from "@/domain/billing-event";
import { assistantEnv, env } from "@/lib/env";
import { AnthropicProvider } from "./anthropic";
import { FakeAssistantProvider } from "./fake-assistant";
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

/**
 * Which model the assistant route talks to. The same rule as above, variable
 * for variable: the real one unless `ASSISTANT_PROVIDER` says `fake` by name,
 * and never the fake once NODE_ENV is production — that adapter answers from a
 * template, so a deployment misconfigured into it would meter a paid feature
 * and bill for a reply nobody wrote.
 *
 * The end-to-end suite is what the fake exists for here too. It drives the
 * quota, the spend cap and the entitlement drop through this route in a real
 * browser, and there is no model account behind CI to drive them against.
 */
export function assistantProvider(): IAssistantProvider {
  if (process.env.ASSISTANT_PROVIDER === "fake") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ASSISTANT_PROVIDER=fake is refused in production");
    }
    return new FakeAssistantProvider();
  }

  return new AnthropicProvider(assistantEnv().ANTHROPIC_API_KEY);
}
