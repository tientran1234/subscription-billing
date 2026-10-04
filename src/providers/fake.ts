/**
 * In-memory provider. Lets the whole flow — checkout, webhook, status change,
 * entitlement — run in tests and in local dev with no Stripe account and no
 * network. Any new provider must pass the same conformance test this one does.
 */
import { createHmac } from "node:crypto";
import { DEFAULT_CURRENCY } from "@/domain/currency";
import {
  type BillingEvent,
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

/** What a preview quotes. Made up — the fake is here for the flow, not the money. */
export const FAKE_PRORATION_MINOR = 1_234;

export class FakeProvider implements IBillingProvider {
  readonly name = "fake";

  /**
   * Every checkout opened, preview taken and plan change made through this
   * provider. Nothing in the app reads them; they are how a test sees which
   * subscription was repriced, what trial and how many seats a checkout asked
   * for, and that a refused change never reached the provider at all.
   */
  readonly checkouts: CreateCheckoutInput[] = [];
  readonly previews: PreviewPlanChangeInput[] = [];
  readonly planChanges: ChangePlanInput[] = [];

  /**
   * Every event this gateway has delivered, by id — what `fetchEvent` reads
   * back out, the way Stripe keeps a month of its own. Filled by
   * `verifyWebhook`, because what a gateway can be asked for again is exactly
   * what it sent. It lives on the adapter, and the app builds one per request,
   * so re-fetching is for the suites that drive this provider directly.
   */
  readonly delivered = new Map<string, BillingEvent>();

  constructor(private readonly secret = "fake-secret") {}

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    this.checkouts.push(input);
    const checkoutRef = `cs_fake_${input.subscriptionId}`;
    return { checkoutUrl: `https://fake.checkout/${checkoutRef}`, checkoutRef };
  }

  async createPortalSession(input: CreatePortalInput): Promise<CreatePortalResult> {
    const returnTo = encodeURIComponent(input.returnUrl);
    return { portalUrl: `https://fake.portal/${input.customerRef}?return_to=${returnTo}` };
  }

  async previewPlanChange(input: PreviewPlanChangeInput): Promise<PlanChangePreview> {
    this.previews.push(input);
    return {
      amountDueMinor: FAKE_PRORATION_MINOR,
      // The currency it was asked to quote in, not one of its own choosing: a
      // gateway bills a subscription in the currency it was created with, so a
      // quote in another is an amount the customer could never be charged.
      currency: input.currency ?? DEFAULT_CURRENCY,
      prorationDate: new Date(),
      nextInvoiceAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
  }

  async changePlan(input: ChangePlanInput): Promise<void> {
    this.planChanges.push(input);
  }

  /** Sign a payload the way the fake gateway would — test helper. */
  sign(rawBody: string): string {
    return createHmac("sha256", this.secret).update(rawBody).digest("hex");
  }

  async verifyWebhook(rawBody: string, signature: string): Promise<BillingEvent> {
    if (signature !== this.sign(rawBody)) {
      throw new WebhookVerificationError("bad signature");
    }
    const parsed = JSON.parse(rawBody) as BillingEvent & { currentPeriodEnd?: string };
    const event = {
      ...parsed,
      currentPeriodEnd: parsed.currentPeriodEnd ? new Date(parsed.currentPeriodEnd) : undefined,
    };
    this.delivered.set(event.providerEventId, event);
    return event;
  }

  async fetchEvent(providerEventId: string): Promise<BillingEvent | null> {
    return this.delivered.get(providerEventId) ?? null;
  }
}
