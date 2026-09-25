/**
 * Stripe adapter — the ONLY file allowed to import `stripe`.
 *
 * It does two things and nothing else: talk to Stripe, and normalize the result
 * into the neutral DTOs in src/domain/billing-event.ts. It never touches the
 * database and never decides a subscription's status; that is business logic
 * and lives in src/server/billing.service.ts.
 */
import Stripe from "stripe";
import {
  type BillingEvent,
  type BillingEventType,
  type ChangePlanInput,
  type CreateCheckoutInput,
  type CreateCheckoutResult,
  type CreatePortalInput,
  type CreatePortalResult,
  type IBillingProvider,
  type PlanChangePreview,
  type PreviewPlanChangeInput,
  WebhookVerificationError,
} from "@/domain/billing-event";

/**
 * Only the fields we actually read, declared locally on purpose: an SDK or API
 * version bump then shows up as a compile error here instead of quietly
 * reshaping what business logic receives.
 */
interface SessionLike {
  id: string;
  subscription?: string | { id: string } | null;
  customer?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
}
interface InvoiceLike {
  subscription?: string | { id: string } | null;
  customer?: string | { id: string } | null;
  lines?: { data?: Array<{ period?: { end?: number } }> };
  /** Stripe's snapshot of the subscription's metadata when it finalized this. */
  subscription_details?: { metadata?: Record<string, string> | null } | null;
}
interface SubscriptionLike {
  id: string;
  customer?: string | { id: string } | null;
  current_period_end?: number;
  metadata?: Record<string, string> | null;
}

const refOf = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
};

const secondsToDate = (seconds: unknown): Date | undefined =>
  typeof seconds === "number" ? new Date(seconds * 1000) : undefined;

/**
 * The item a plan change reprices. A subscription started by `createCheckout`
 * has exactly one line, so there is nothing to choose between; a subscription
 * with none is not ours to reprice and says so rather than guessing.
 */
async function repricedItem(
  stripe: Stripe,
  providerRef: string,
): Promise<{ itemId: string; customerRef?: string }> {
  const subscription = await stripe.subscriptions.retrieve(providerRef);
  const itemId = subscription.items.data[0]?.id;
  if (!itemId) throw new Error(`Stripe subscription ${providerRef} has no item to reprice`);
  return { itemId, customerRef: refOf(subscription.customer) };
}

export class StripeProvider implements IBillingProvider {
  readonly name = "stripe";
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: input.priceRef, quantity: 1 }],
      // Echoed back on the webhook, so we can find our row without a lookup.
      client_reference_id: input.subscriptionId,
      metadata: { subscriptionId: input.subscriptionId, planKey: input.planKey },
      subscription_data: {
        metadata: { subscriptionId: input.subscriptionId, planKey: input.planKey },
      },
      customer_email: input.customerEmail,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error("Stripe returned a session with no URL");
    return { checkoutUrl: session.url, checkoutRef: session.id };
  }

  async createPortalSession(input: CreatePortalInput): Promise<CreatePortalResult> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerRef,
      return_url: input.returnUrl,
    });
    return { portalUrl: session.url };
  }

  async previewPlanChange(input: PreviewPlanChangeInput): Promise<PlanChangePreview> {
    const { itemId, customerRef } = await repricedItem(this.stripe, input.providerRef);

    // Fixing the instant ourselves, rather than letting Stripe pick one per
    // call, is what makes the quote binding: changePlan sends this very number
    // back and Stripe then bills the amount previewed here.
    const prorationDate = Math.floor(Date.now() / 1000);

    const invoice = await this.stripe.invoices.retrieveUpcoming({
      customer: customerRef,
      subscription: input.providerRef,
      subscription_details: {
        items: [{ id: itemId, price: input.priceRef, quantity: 1 }],
        proration_behavior: "always_invoice",
        proration_date: prorationDate,
      },
    });

    return {
      amountDueMinor: invoice.amount_due,
      currency: invoice.currency,
      prorationDate: new Date(prorationDate * 1000),
      nextInvoiceAt: secondsToDate(invoice.next_payment_attempt ?? invoice.period_end),
    };
  }

  async changePlan(input: ChangePlanInput): Promise<void> {
    const { itemId } = await repricedItem(this.stripe, input.providerRef);

    await this.stripe.subscriptions.update(input.providerRef, {
      items: [{ id: itemId, price: input.priceRef, quantity: 1 }],
      // Invoice the proration now instead of parking it on the next renewal:
      // the paid invoice is what tells us the plan moved, and a tenant should
      // not wait a month for the plan they just bought.
      proration_behavior: "always_invoice",
      proration_date: Math.floor(input.prorationDate.getTime() / 1000),
      // Metadata is merged, and the invoice snapshots it — which is how the
      // new plan reaches applyEvent without anything writing it locally.
      metadata: { planKey: input.planKey },
    });
  }

  async verifyWebhook(rawBody: string, signature: string): Promise<BillingEvent> {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (err) {
      throw new WebhookVerificationError((err as Error).message);
    }
    return normalize(event);
  }
}

/** Exported for the tests: the mapping is the part worth asserting. */
export function normalize(event: Stripe.Event): BillingEvent {
  const base = { providerEventId: event.id };
  const object = event.data.object as unknown;

  switch (event.type) {
    case "checkout.session.completed": {
      const s = object as SessionLike;
      return {
        ...base,
        type: "subscription_activated",
        checkoutRef: s.id,
        providerRef: refOf(s.subscription),
        customerRef: refOf(s.customer),
        planKey: s.metadata?.planKey,
      };
    }

    // Renewals. The first invoice also lands here, right after checkout — the
    // state machine turns that into a no-op instead of a second activation.
    case "invoice.paid": {
      const i = object as InvoiceLike;
      return {
        ...base,
        type: "subscription_activated",
        providerRef: refOf(i.subscription),
        customerRef: refOf(i.customer),
        // The plan in force when this invoice was finalized. On a plan change
        // that is the new one, and the paid invoice is the evidence the money
        // for it was taken.
        planKey: i.subscription_details?.metadata?.planKey,
        currentPeriodEnd: secondsToDate(i.lines?.data?.[0]?.period?.end),
      };
    }

    case "invoice.payment_failed": {
      const i = object as InvoiceLike;
      return {
        ...base,
        type: "payment_failed",
        providerRef: refOf(i.subscription),
        customerRef: refOf(i.customer),
      };
    }

    case "customer.subscription.deleted": {
      const s = object as SubscriptionLike;
      return {
        ...base,
        type: "subscription_canceled",
        providerRef: s.id,
        customerRef: refOf(s.customer),
      };
    }

    default:
      return { ...base, type: "unknown" as BillingEventType };
  }
}
