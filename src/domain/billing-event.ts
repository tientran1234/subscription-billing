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

export interface CreatePortalInput {
  /** Provider-side customer id, resolved from the caller's own tenant. */
  customerRef: string;
  /** Where the provider sends the customer back when they are done. */
  returnUrl: string;
}

export interface CreatePortalResult {
  portalUrl: string;
}

export interface PreviewPlanChangeInput {
  /** Provider's subscription id — the one being repriced. */
  providerRef: string;
  /** Provider-side price id of the plan being moved to. */
  priceRef: string;
}

export interface PlanChangePreview {
  /** Payable now, in the currency's minor unit, net of any unused time. */
  amountDueMinor: number;
  currency: string;
  /**
   * The instant the proration was computed at. Handed back on confirm so the
   * provider bills the amount that was quoted instead of recomputing it for
   * whenever the customer got round to clicking.
   */
  prorationDate: Date;
  /** When the next full invoice falls due, when the provider says. */
  nextInvoiceAt?: Date;
}

export interface ChangePlanInput extends PreviewPlanChangeInput {
  /** Our plan key. The provider stores it, so the paid invoice carries it back. */
  planKey: string;
  prorationDate: Date;
}

export interface IBillingProvider {
  readonly name: string;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  /**
   * A short-lived, authenticated link into the provider's own billing portal,
   * where the customer cancels, resumes or updates their card.
   *
   * Cancelling and resuming are deliberately not methods here: a status is
   * changed on the provider's side and reaches us as a webhook, so the state
   * machine stays the one path it can move along.
   */
  createPortalSession(input: CreatePortalInput): Promise<CreatePortalResult>;
  /**
   * What moving to `priceRef` would cost right now: the proration computed,
   * quoted, and not charged. Nothing here changes a subscription, so a preview
   * the customer abandons leaves nothing behind.
   */
  previewPlanChange(input: PreviewPlanChangeInput): Promise<PlanChangePreview>;
  /**
   * Move the subscription to `priceRef`, invoicing the proration as of the
   * instant the preview quoted.
   *
   * The one method here that changes a subscription — and deliberately not one
   * that changes its status: it moves a price. The new plan comes back on the
   * webhook for the invoice that pays for it, so applyEvent is still the only
   * writer of what a tenant is entitled to.
   */
  changePlan(input: ChangePlanInput): Promise<void>;
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
