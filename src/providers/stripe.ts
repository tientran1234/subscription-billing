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
  type CreateCheckoutInput,
  type CreateCheckoutResult,
  type IBillingProvider,
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
  metadata?: Record<string, string> | null;
}
interface InvoiceLike {
  subscription?: string | { id: string } | null;
  lines?: { data?: Array<{ period?: { end?: number } }> };
}
interface SubscriptionLike {
  id: string;
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
        currentPeriodEnd: secondsToDate(i.lines?.data?.[0]?.period?.end),
      };
    }

    case "invoice.payment_failed": {
      const i = object as InvoiceLike;
      return { ...base, type: "payment_failed", providerRef: refOf(i.subscription) };
    }

    case "customer.subscription.deleted": {
      const s = object as SubscriptionLike;
      return { ...base, type: "subscription_canceled", providerRef: s.id };
    }

    default:
      return { ...base, type: "unknown" as BillingEventType };
  }
}
