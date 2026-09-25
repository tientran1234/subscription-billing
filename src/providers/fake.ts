/**
 * In-memory provider. Lets the whole flow — checkout, webhook, status change,
 * entitlement — run in tests and in local dev with no Stripe account and no
 * network. Any new provider must pass the same conformance test this one does.
 */
import { createHmac } from "node:crypto";
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
const FAKE_PRORATION_MINOR = 1_234;

export class FakeProvider implements IBillingProvider {
  readonly name = "fake";

  /**
   * Every preview taken and every plan change made through this provider.
   * Nothing in the app reads them; they are how a test sees which
   * subscription was repriced, and that a refused change never reached the
   * provider at all.
   */
  readonly previews: PreviewPlanChangeInput[] = [];
  readonly planChanges: ChangePlanInput[] = [];

  constructor(private readonly secret = "fake-secret") {}

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
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
      currency: "usd",
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
    return {
      ...parsed,
      currentPeriodEnd: parsed.currentPeriodEnd ? new Date(parsed.currentPeriodEnd) : undefined,
    };
  }
}
