/**
 * The provider-neutral contract.
 *
 * Business logic switches on THESE types, never on `Stripe.*`. Only
 * src/providers/stripe.ts is allowed to import the `stripe` package, so
 * swapping or adding a provider (Paddle, LemonSqueezy, PayOS) means writing one
 * adapter that satisfies `IBillingProvider` — nothing else changes.
 */

export type BillingEventType =
  | "subscription_activated"
  | "payment_failed"
  | "subscription_canceled"
  | "subscription_expired"
  | "unknown";

export interface BillingEvent {
  /** Unique per delivered event — this is what makes replay a no-op. */
  providerEventId: string;
  type: BillingEventType;
  /** Provider's subscription id, when the event carries one. */
  providerRef?: string;
  /** Provider's checkout session id, when the event carries one. */
  checkoutRef?: string;
  /**
   * Provider's customer id. Not known at checkout — it is created by the
   * provider and only ever reaches us on a webhook, which is why it is stored
   * from here rather than written when the subscription row is created.
   */
  customerRef?: string;
  planKey?: string;
  currentPeriodEnd?: Date;
}

export interface CreateCheckoutInput {
  subscriptionId: string;
  planKey: string;
  /** Provider-side price id for that plan (Stripe: price_…). */
  priceRef: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateCheckoutResult {
  checkoutUrl: string;
  checkoutRef: string;
}

export interface IBillingProvider {
  readonly name: string;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  /**
   * Verify the signature over the RAW request bytes, then normalize.
   * Throws {@link WebhookVerificationError} when the signature does not match.
   */
  verifyWebhook(rawBody: string, signature: string): Promise<BillingEvent>;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}
