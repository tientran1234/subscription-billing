/**
 * In-memory provider. Lets the whole flow — checkout, webhook, status change,
 * entitlement — run in tests and in local dev with no Stripe account and no
 * network. Any new provider must pass the same conformance test this one does.
 */
import { createHmac } from "node:crypto";
import {
  type BillingEvent,
  type CreateCheckoutInput,
  type CreateCheckoutResult,
  type CreatePortalInput,
  type CreatePortalResult,
  type IBillingProvider,
  WebhookVerificationError,
} from "@/domain/billing-event";

export class FakeProvider implements IBillingProvider {
  readonly name = "fake";

  constructor(private readonly secret = "fake-secret") {}

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const checkoutRef = `cs_fake_${input.subscriptionId}`;
    return { checkoutUrl: `https://fake.checkout/${checkoutRef}`, checkoutRef };
  }

  async createPortalSession(input: CreatePortalInput): Promise<CreatePortalResult> {
    const returnTo = encodeURIComponent(input.returnUrl);
    return { portalUrl: `https://fake.portal/${input.customerRef}?return_to=${returnTo}` };
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
