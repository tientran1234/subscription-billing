/**
 * Stripe's test clock, for the gateway CI can actually run against.
 *
 * A renewal is the one billing event nobody can wait for: it falls due a month
 * after checkout. Stripe's answer is a test clock — an account-side "now" you
 * advance, and it raises the invoices that come due on the way. The in-memory
 * gateway has no clock of its own, so this is it: the instant the suite says it
 * is, plus the deliveries the gateway would have made by then, signed the way
 * it signs them and posted where Stripe would post them.
 *
 * Which events carry which fields is copied from the Stripe adapter rather than
 * invented. A completed checkout activates and names the refs; a paid invoice
 * carries the period it bought and, on a plan change, the plan it was raised
 * for. Getting that wrong here would prove the app right about a shape it never
 * receives.
 */
import type { APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import type { BillingEvent } from "@/domain/billing-event";
import { FakeProvider } from "@/providers/fake";
import { APP_ENV } from "./app";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A month, as this suite counts one. Nothing here is billing anybody. */
export const PERIOD_DAYS = 30;

/** One delivery's exact bytes, kept so a spec can post the very same one twice. */
export interface Delivery {
  rawBody: string;
  signature: string;
}

/** What the webhook route answered. Every outcome is a 200 — see the route. */
export interface Receipt {
  status: number;
  outcome: string;
}

export interface SubscriptionRefs {
  checkoutRef: string;
  providerRef: string;
  customerRef: string;
  planKey: string;
}

export class BillingClock {
  /** Unique per clock, so specs sharing one Postgres cannot collide on ids. */
  private readonly tag = randomBytes(5).toString("hex");
  private delivered = 0;
  private at: Date;

  constructor(
    private readonly request: APIRequestContext,
    start = new Date("2026-01-15T00:00:00.000Z"),
  ) {
    this.at = start;
  }

  get now(): Date {
    return new Date(this.at);
  }

  /** Every event id this clock has minted, for cleaning up after a test. */
  get eventIdPrefix(): string {
    return `evt_${this.tag}_`;
  }

  advanceBy(days: number): Date {
    this.at = new Date(this.at.getTime() + days * DAY_MS);
    return this.now;
  }

  /** The period an invoice paid at this instant buys. */
  periodEnd(): Date {
    return new Date(this.at.getTime() + PERIOD_DAYS * DAY_MS);
  }

  /** A completed checkout: activates, and names the refs it just learned. */
  activation(refs: SubscriptionRefs): Delivery {
    // No period end on purpose. Stripe's checkout.session.completed does not
    // carry one either — the invoice that pays for the period does.
    return this.sign({
      type: "subscription_activated",
      checkoutRef: refs.checkoutRef,
      providerRef: refs.providerRef,
      customerRef: refs.customerRef,
      planKey: refs.planKey,
    });
  }

  /**
   * A paid invoice: the money for one period, and the plan and seat count it
   * was taken for.
   */
  paidInvoice(input: { providerRef: string; planKey?: string; seats?: number }): Delivery {
    return this.sign({
      type: "subscription_activated",
      providerRef: input.providerRef,
      planKey: input.planKey,
      seats: input.seats,
      currentPeriodEnd: this.periodEnd(),
    });
  }

  cancellation(input: { providerRef: string }): Delivery {
    return this.sign({ type: "subscription_canceled", providerRef: input.providerRef });
  }

  private sign(event: Omit<BillingEvent, "providerEventId">): Delivery {
    const rawBody = JSON.stringify({
      providerEventId: `${this.eventIdPrefix}${++this.delivered}`,
      ...event,
    });
    return { rawBody, signature: new FakeProvider(APP_ENV.STRIPE_WEBHOOK_SECRET).sign(rawBody) };
  }

  /**
   * Deliver it. The bytes go over the wire untouched and the signature covers
   * exactly them, which is the property the route's `request.text()` exists for
   * — post `data:` instead and Playwright would re-serialize the object.
   */
  async send(delivery: Delivery): Promise<Receipt> {
    const response = await this.request.post("/api/webhooks/stripe", {
      headers: {
        "content-type": "application/json",
        // The header Stripe sends, whichever adapter is answering: the route
        // reads one name, so the fake has to arrive under it too.
        "stripe-signature": delivery.signature,
      },
      data: delivery.rawBody,
    });
    return { status: response.status(), outcome: (await response.json()).outcome };
  }
}
