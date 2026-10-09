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
  type ListInvoicesInput,
  type PlanChangePreview,
  type PreviewPlanChangeInput,
  type ReportUsageInput,
  type SetCustomerLocaleInput,
  WebhookVerificationError,
} from "@/domain/billing-event";
import type { Invoice } from "@/domain/invoice";

/** What a preview quotes. Made up — the fake is here for the flow, not the money. */
export const FAKE_PRORATION_MINOR = 1_234;

/**
 * The history this gateway holds for any customer: a month it is still
 * assembling, a month that went unpaid, and a month that was paid.
 *
 * Synthesized rather than seeded by whoever is testing, because the app builds
 * one adapter per request — nothing a suite pushed in beforehand would still
 * be there when the page rendered. Fixed dates, newest first, and the three
 * statuses that matter to this list in one fixture: the draft is the row that
 * must never reach a customer, the open one is what a past-due customer opens
 * the page to pay, and only the issued two carry a document, because a gateway
 * has nothing to host for an invoice it has not finalized.
 */
const FAKE_INVOICES: readonly Omit<Invoice, "id" | "hostedUrl" | "pdfUrl">[] = [
  {
    number: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    status: "draft",
    totalMinor: 9_900,
    currency: DEFAULT_CURRENCY,
  },
  {
    number: "FAKE-0002",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    status: "open",
    totalMinor: 2_900,
    currency: DEFAULT_CURRENCY,
  },
  {
    number: "FAKE-0001",
    createdAt: new Date("2026-05-01T00:00:00Z"),
    status: "paid",
    totalMinor: 2_900,
    currency: DEFAULT_CURRENCY,
  },
];

export class FakeProvider implements IBillingProvider {
  readonly name = "fake";

  /**
   * Every checkout opened, preview taken, plan change made, usage figure
   * reported and language recorded through this provider. Nothing in the app
   * reads them; they are how a test sees which subscription was repriced, what
   * trial and how many seats a checkout asked for, that a refused change never
   * reached the provider at all, that a month's overage was reported exactly
   * once, and whose customer was told to write in which language.
   */
  readonly checkouts: CreateCheckoutInput[] = [];
  readonly previews: PreviewPlanChangeInput[] = [];
  readonly planChanges: ChangePlanInput[] = [];
  readonly usageReports: ReportUsageInput[] = [];
  readonly customerLocales: SetCustomerLocaleInput[] = [];

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

  async listInvoices(input: ListInvoicesInput): Promise<Invoice[]> {
    // The customer rides in the ids and the links, the way it rides in the
    // portal url above: that is what lets a test see WHOSE invoices came back,
    // and reading another workspace's is the one thing this endpoint could do
    // wrong that nobody would notice.
    return FAKE_INVOICES.slice(0, input.limit).map((invoice, index) => {
      const id = `in_fake_${input.customerRef}_${index}`;
      const hosted = invoice.status === "draft" ? null : `https://fake.invoice/${id}`;
      return { ...invoice, id, hostedUrl: hosted, pdfUrl: hosted && `${hosted}.pdf` };
    });
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

  async reportUsage(input: ReportUsageInput): Promise<void> {
    this.usageReports.push(input);
  }

  async setCustomerLocale(input: SetCustomerLocaleInput): Promise<void> {
    this.customerLocales.push(input);
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
