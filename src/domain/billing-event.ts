/**
 * The provider-neutral contract.
 *
 * Business logic switches on THESE types, never on `Stripe.*`. Only
 * src/providers/stripe.ts is allowed to import the `stripe` package, so
 * swapping or adding a provider (Paddle, LemonSqueezy, PayOS) means writing one
 * adapter that satisfies `IBillingProvider` — nothing else changes.
 */

import type { Invoice, InvoicePage } from "./invoice";

export type BillingEventType =
  | "subscription_activated"
  /** Checkout completed on a plan with a trial: access now, first invoice later. */
  | "subscription_trialing"
  /** The provider's heads-up that a trial is about to run out. */
  | "trial_ending"
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
  /**
   * Seats the provider billed for. Reaches us the way `planKey` does — on the
   * invoice that took the money — so a seat change is evidence rather than an
   * intention.
   */
  seats?: number;
  currentPeriodEnd?: Date;
}

export interface CreateCheckoutInput {
  subscriptionId: string;
  planKey: string;
  /** Provider-side price id for that plan (Stripe: price_…). */
  priceRef: string;
  /**
   * Days of free trial to grant, from the plan being bought. Omitted or 0 means
   * the subscription is billed from the start.
   */
  trialDays?: number;
  /**
   * Seats to bill — the `quantity` on the provider's price. Omitted means one,
   * which is the common checkout: one person buying for themselves.
   */
  seats?: number;
  /**
   * Provider-side price id for the metered add-on, for a plan that bills what
   * is used beyond its quota. Omitted means the quota is where that plan stops,
   * and the subscription is then created with nothing to report usage against.
   */
  overagePriceRef?: string;
  /**
   * Currency to bill in — the one the customer was quoted. Omitted leaves the
   * provider on its own default for the price. A plain string, like `planKey`:
   * the neutral layer says what we want and each adapter knows what its
   * gateway calls it.
   */
  currency?: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateCheckoutResult {
  checkoutUrl: string;
  checkoutRef: string;
}

export interface ReportUsageInput {
  /** Provider's subscription id — the one carrying the metered add-on. */
  providerRef: string;
  /**
   * Units past the plan's quota. Never the raw counter: the plan has already
   * been paid for, so reporting everything metered would charge twice for the
   * messages it includes.
   */
  quantity: number;
  /**
   * The closed month the figure was counted over, `YYYY-MM`. It does not say
   * when the provider bills it — a usage record lands on the invoice for the
   * provider's own current period, and a billing cycle is not a UTC month — but
   * it is what makes a second report of the same month a no-op at the provider
   * as well as here.
   */
  period: string;
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

export interface ListInvoicesInput {
  /** Provider-side customer id, resolved from the caller's own tenant. */
  customerRef: string;
  /**
   * How many of the customer's most recent invoices to read, newest first.
   * Passed in rather than decided here: how long an invoice history is is a
   * product question, and it is answered in src/domain/invoice.ts.
   */
  limit: number;
  /**
   * The gateway's id for the last invoice of the window before this one; the
   * window read is the one starting after it. Absent for the first window.
   *
   * The gateway's cursor and not one of ours. The keyset we page our own
   * tables with — see src/domain/transactions.ts — names a row by (createdAt,
   * id) in a table this app has, and an invoice is in no table here; an
   * archive can only be paged from a position its owner recognises.
   */
  startingAfter?: string;
}

export interface PreviewPlanChangeInput {
  /** Provider's subscription id — the one being repriced. */
  providerRef: string;
  /** Provider-side price id of the plan being moved to. */
  priceRef: string;
  /** Seats to be billed after the change. Omitted means one. */
  seats?: number;
  /**
   * The currency the subscription is already billed in, read off our own row.
   * Deliberately not something a caller may choose: a provider fixes it at
   * creation and will not move a live subscription, so a quote in any other
   * currency would be a price nobody could be charged.
   */
  currency?: string;
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

export interface SetCustomerLocaleInput {
  /** Provider-side customer id, resolved from the caller's own tenant. */
  customerRef: string;
  /**
   * The languages to record on the customer, most preferred first, by the rule
   * in src/domain/notice-locale.ts. Plain strings rather than our own `Locale`:
   * this is the gateway's column, and which of the values it can actually
   * compose in is the gateway's to answer.
   */
  preferredLocales: string[];
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
   * The customer's most recent invoices, as the provider holds them.
   *
   * A read, and the only one here that is not about an event. Nothing is
   * stored from it: an invoice keeps changing after it is raised — a retried
   * payment, an amount written off, a credit note — and a copy of one would be
   * a second answer to what a customer was charged, disagreeing with the
   * document they can already open.
   *
   * Which of them are history is not the adapter's to decide; it normalizes
   * what the gateway has, including the draft the gateway is still assembling,
   * and the rule in src/domain/invoice.ts drops that.
   *
   * One window, not the archive. `hasMore` is the gateway's own answer about
   * what lies behind it, because the adapter is the only thing that can tell
   * the difference between a window that ends the list and one that merely
   * filled up; `startingAfter` reads the next.
   */
  listInvoices(input: ListInvoicesInput): Promise<InvoicePage>;
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
  /**
   * Report usage past the plan's quota, for the provider to bill on its next
   * invoice.
   *
   * It adds to the period's usage rather than setting it, and carries the
   * period in an idempotency key of its own: a billing cycle is not a UTC
   * month, so two months' reports can land on one invoice and a write that set
   * the figure would overwrite the first of them with the second.
   *
   * Nothing here decides what is owed — the units arrive computed, by the rule
   * in src/domain/overage.ts — and nothing here records that the month was
   * reported, which is a claim in our own tables.
   */
  reportUsage(input: ReportUsageInput): Promise<void>;
  /**
   * Record on the provider's own customer which language it should compose its
   * own mail in — its receipts, its card-expiry warnings.
   *
   * A write, and the only one here that is not about money. It carries no
   * subscription and no price: the gateway decides nothing differently for
   * having been told, it just stops writing to a Vietnamese workspace in
   * English while this application writes to them in Vietnamese. So it is not
   * the second writer of `status` the list in the conformance suite guards
   * against — there is no event, and nothing comes back.
   *
   * Which language is not the adapter's to decide, and neither is whether to
   * cross at all: the value arrives resolved and only when a workspace has
   * picked one.
   */
  setCustomerLocale(input: SetCustomerLocaleInput): Promise<void>;
  /**
   * The provider's own copy of an event, by the id it was delivered under, or
   * `null` when the provider has none. Normalized through the same code a
   * webhook goes through, so a replay cannot mean something different from the
   * delivery it repairs.
   *
   * Re-fetched rather than taken from the caller: a payload posted by hand
   * carries no signature, and accepting one would make the replay endpoint a
   * second, unsigned writer of everything applyEvent decides.
   */
  fetchEvent(providerEventId: string): Promise<BillingEvent | null>;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}
