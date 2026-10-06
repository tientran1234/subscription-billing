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
  type ListInvoicesInput,
  type PlanChangePreview,
  type PreviewPlanChangeInput,
  type ReportUsageInput,
  WebhookVerificationError,
} from "@/domain/billing-event";
import { invoiceStatusFrom, type Invoice } from "@/domain/invoice";

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
interface ItemLike {
  id: string;
  price?: { recurring?: { usage_type?: string } | null } | null;
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

/** Metadata is strings. One that is absent or not a number is simply no count. */
const seatsFrom = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const seats = Number(value);
  return Number.isFinite(seats) ? seats : undefined;
};

/**
 * Which item is the plan, and which is the add-on beside it. Exported for the
 * tests, because picking the wrong one of the two is silent: a plan change
 * would reprice the metered item and bill the customer for a plan they never
 * chose, and a usage record against the licensed item is refused outright.
 *
 * A subscription bought before the add-on existed has only the licensed item,
 * which is why `meteredItemOf` answers `undefined` rather than throwing — the
 * caller knows whether this one is supposed to carry one.
 */
export function licensedItemOf(items: readonly ItemLike[]): ItemLike | undefined {
  return items.find((item) => item.price?.recurring?.usage_type !== "metered");
}

export function meteredItemOf(items: readonly ItemLike[]): ItemLike | undefined {
  return items.find((item) => item.price?.recurring?.usage_type === "metered");
}

/**
 * The item a plan change reprices: the licensed one, deliberately not the first
 * one Stripe lists. A plan that sells the metered add-on has two items and
 * their order is not promised, so `data[0]` would be a coin toss between the
 * price the customer is changing and the meter beside it.
 */
async function repricedItem(
  stripe: Stripe,
  providerRef: string,
): Promise<{ itemId: string; customerRef?: string }> {
  const subscription = await stripe.subscriptions.retrieve(providerRef);
  const itemId = licensedItemOf(subscription.items.data)?.id;
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
    const trialDays = input.trialDays ?? 0;
    const seats = input.seats ?? 1;

    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        { price: input.priceRef, quantity: seats },
        // The metered add-on, for a plan that bills past its quota. No quantity
        // on this one: what it charges for is the usage reported against it,
        // and Stripe refuses a metered line that carries a count.
        ...(input.overagePriceRef ? [{ price: input.overagePriceRef }] : []),
      ],
      // A Stripe Price carries an amount per currency of its own
      // (`currency_options`), so the session names which of them this customer
      // is buying at. That keeps one price id per plan rather than one per
      // plan per currency for an operator to keep in step, and it is what
      // fixes the subscription's currency for the rest of its life.
      currency: input.currency,
      // Echoed back on the webhook, so we can find our row without a lookup.
      client_reference_id: input.subscriptionId,
      // `trialDays` rides along because the completed-session event has to be
      // able to say whether a trial was granted, and Stripe's session object
      // carries no trial field to read it off — the same route `planKey`
      // already takes to reach us.
      metadata: {
        subscriptionId: input.subscriptionId,
        planKey: input.planKey,
        ...(trialDays > 0 ? { trialDays: String(trialDays) } : {}),
      },
      subscription_data: {
        // `seats` rides on the subscription so the invoices it raises snapshot
        // it, which is how a seat count reaches applyEvent. The quantity is on
        // the line item too, but a proration invoice has several lines and no
        // promised order, so reading one back off them would be a guess.
        metadata: {
          subscriptionId: input.subscriptionId,
          planKey: input.planKey,
          seats: String(seats),
        },
        ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
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

  async listInvoices(input: ListInvoicesInput): Promise<Invoice[]> {
    // No `status` filter on the call, though Stripe takes one: it takes
    // exactly one status, and the four this list shows would be four requests.
    // Which of them are history is our rule anyway — see domain/invoice.ts —
    // and asking the gateway to apply half of it would put it in two places.
    const page = await this.stripe.invoices.list({
      customer: input.customerRef,
      limit: input.limit,
    });
    return page.data.map(normalizeInvoice);
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
      currency: input.currency,
      subscription_details: {
        items: [{ id: itemId, price: input.priceRef, quantity: input.seats ?? 1 }],
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

    const seats = input.seats ?? 1;

    // No currency on the update: Stripe fixed the subscription's when it was
    // created and refuses to move a live one, so the item below is repriced in
    // the currency it already has — the same one the preview quoted in.
    await this.stripe.subscriptions.update(input.providerRef, {
      items: [{ id: itemId, price: input.priceRef, quantity: seats }],
      // Invoice the proration now instead of parking it on the next renewal:
      // the paid invoice is what tells us the plan moved, and a tenant should
      // not wait a month for the plan they just bought.
      proration_behavior: "always_invoice",
      proration_date: Math.floor(input.prorationDate.getTime() / 1000),
      // Metadata is merged, and the invoice snapshots it — which is how the
      // new plan and seat count reach applyEvent without anything writing them
      // locally.
      metadata: { planKey: input.planKey, seats: String(seats) },
    });
  }

  async reportUsage(input: ReportUsageInput): Promise<void> {
    const subscription = await this.stripe.subscriptions.retrieve(input.providerRef);
    const itemId = meteredItemOf(subscription.items.data)?.id;
    // A subscription our own row says carries the add-on but Stripe has no
    // meter on is a misconfiguration, not an answer: throwing leaves the
    // caller's claim released and the month still owing, which is the only
    // honest outcome — the alternative is a month recorded as billed that
    // nothing was ever charged for.
    if (!itemId) {
      throw new Error(`Stripe subscription ${input.providerRef} has no metered item`);
    }

    await this.stripe.subscriptionItems.createUsageRecord(
      itemId,
      {
        quantity: input.quantity,
        // Add to the period rather than set it: Stripe bills a usage record on
        // whichever of its own billing periods is open when it arrives, and two
        // UTC months can fall inside one of those, so `set` would overwrite the
        // first month's figure with the second's.
        action: "increment",
        // Left at Stripe's default of now, deliberately. A usage record has to
        // be timestamped inside the subscription's current billing period, and
        // the month being reported has by definition closed — dating it back
        // would be refused. The figure is last month's; the invoice it rides is
        // the next one.
      },
      // The second line of defence, the claim in `UsageReport` being the first:
      // a run that lost its claim, or one somebody starts by hand, is deduped
      // by the provider on the pair that identifies the report.
      { idempotencyKey: `overage:${input.providerRef}:${input.period}` },
    );
  }

  async fetchEvent(providerEventId: string): Promise<BillingEvent | null> {
    try {
      return normalize(await this.stripe.events.retrieve(providerEventId));
    } catch (err) {
      // An id Stripe holds nothing under is an answer rather than a failure:
      // it is what a mistyped id and an id from another account both look like,
      // and the caller refuses the replay on it. Stripe keeps events for a
      // month, so one older than that reads the same way — there is nothing
      // left to re-apply.
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === "resource_missing"
      ) {
        return null;
      }
      throw err;
    }
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

/**
 * One listed invoice, as the neutral DTO. Exported for the tests, like
 * {@link normalize}: nothing but the mapping is worth asserting here, and the
 * two fields that go quietly wrong are the status — which decides whether a
 * customer is told they were charged — and the hosted links, which Stripe
 * leaves off an invoice it has not finalized.
 *
 * Read off the SDK's own `Stripe.Invoice` rather than a locally declared
 * shape, unlike the event objects below: a listed invoice arrives typed, so a
 * version bump that moves one of these fields is already a compile error here.
 */
export function normalizeInvoice(invoice: Stripe.Invoice): Invoice {
  return {
    id: invoice.id,
    number: invoice.number,
    createdAt: new Date(invoice.created * 1000),
    status: invoiceStatusFrom(invoice.status),
    // The total, not `amount_paid`: an invoice that failed or was written off
    // is still part of the history, and showing nothing paid as nothing owed
    // would hide the one row a past-due customer opened this page to find.
    totalMinor: invoice.total,
    currency: invoice.currency,
    // Rendered straight into the page, unlike a portal link: these live on the
    // invoice itself rather than being minted per click, so one read today is
    // still the same document tomorrow.
    hostedUrl: invoice.hosted_invoice_url ?? null,
    pdfUrl: invoice.invoice_pdf ?? null,
  };
}

/** Exported for the tests: the mapping is the part worth asserting. */
export function normalize(event: Stripe.Event): BillingEvent {
  const base = { providerEventId: event.id };
  const object = event.data.object as unknown;

  switch (event.type) {
    case "checkout.session.completed": {
      const s = object as SessionLike;
      // A checkout on a plan with a trial completes without taking any money,
      // so it activates nothing yet. `createCheckout` wrote the trial into the
      // session's metadata precisely so this branch can tell the two apart.
      const trialing = Number(s.metadata?.trialDays) > 0;
      return {
        ...base,
        type: trialing ? "subscription_trialing" : "subscription_activated",
        // No period end either way: a session says nothing about when the trial
        // or the month it started runs out. The first paid invoice brings that.
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
        // The plan and seat count in force when this invoice was finalized. On
        // a change those are the new ones, and the paid invoice is the evidence
        // the money for them was taken.
        planKey: i.subscription_details?.metadata?.planKey,
        seats: seatsFrom(i.subscription_details?.metadata?.seats),
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

    // A few days before a trial lapses. Normalized under its own name rather
    // than left `unknown`, because "we know what this is and nothing moves" is
    // worth reading back out of the event log — see statusForEvent, which maps
    // it to no status at all.
    case "customer.subscription.trial_will_end": {
      const s = object as SubscriptionLike;
      return {
        ...base,
        type: "trial_ending",
        providerRef: s.id,
        customerRef: refOf(s.customer),
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
