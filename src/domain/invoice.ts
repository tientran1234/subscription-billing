/**
 * What an invoice history is, and which of a gateway's invoices belong in one.
 *
 * Pure — no I/O — like the rest of this directory, and deliberately not a
 * table. An invoice is the gateway's own document: it holds the tax it worked
 * out, the card it charged and the PDF a customer's accountant will ask for,
 * and it keeps changing after it is raised — a payment retried, an amount
 * written off, a credit note against it. A copy here would be a second answer
 * to what somebody was charged, going stale from the moment it was written and
 * disagreeing with the document the customer can already open. So the list is
 * read live, per request, and nothing from it is stored.
 *
 * What is left to decide is which invoices are history, and that is the rule
 * below: a draft is not one.
 */

/** The statuses a gateway's invoice may be in. Ours, like every other DTO. */
export const INVOICE_STATUSES = ["draft", "open", "paid", "void", "uncollectible"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface Invoice {
  /** Gateway-side invoice id. Only ever a key on the page — nothing looks it up. */
  id: string;
  /**
   * The number the gateway printed on the document, which is what a customer
   * quotes when they ask about it. Null until the invoice is finalized, so in
   * practice null only on a draft.
   */
  number: string | null;
  createdAt: Date;
  status: InvoiceStatus;
  /** The invoice total, in the currency's minor unit — see domain/currency.ts. */
  totalMinor: number;
  currency: string;
  /** The gateway's own hosted invoice page, or null when it offers none. */
  hostedUrl: string | null;
  /** The gateway's hosted PDF, or null when it offers none. */
  pdfUrl: string | null;
}

/**
 * How many of a customer's most recent invoices to read.
 *
 * A year of monthly invoices, which is as far back as anyone reads on the way
 * to downloading one. The whole archive lives in the gateway's portal, and the
 * account page already links there — paging this list would be reimplementing
 * that page against a gateway we would then have to page through.
 */
export const INVOICE_HISTORY_LIMIT = 12;

/**
 * Whether an invoice is something the customer was actually billed.
 *
 * A draft is the invoice the gateway is still assembling for a period that has
 * not been invoiced yet: its total can still move, it carries no number, and
 * there is no hosted document behind it to open. Showing one would tell a
 * customer they had been charged an amount that nobody has asked them for —
 * the one way an invoice history can lie. Everything else has been issued and
 * belongs in the list, `void` and `uncollectible` included: an invoice that was
 * cancelled or written off is still part of what happened on the account, and
 * leaving it out would make a month simply disappear.
 */
export function isIssued(status: InvoiceStatus): boolean {
  return status !== "draft";
}

/**
 * A status a gateway reported, as one of ours.
 *
 * Anything absent or unrecognised reads as a draft, which is the one status
 * this list does not show: a gateway that will not say whether an invoice was
 * issued is no grounds for telling a customer they were charged.
 */
export function invoiceStatusFrom(raw: string | null | undefined): InvoiceStatus {
  return (INVOICE_STATUSES as readonly string[]).includes(raw ?? "")
    ? (raw as InvoiceStatus)
    : "draft";
}

/**
 * The issued invoices among `invoices`, newest first.
 *
 * Sorted here rather than trusted from the gateway, because "newest first" is
 * what the page claims and only one line of code can keep that true across
 * adapters. Nothing is capped: the cap is what the gateway was asked for, and
 * capping a second time here would be a second answer to how long the list is.
 *
 * Dropping drafts after the read costs at most one row of the window — a
 * gateway assembles one draft per subscription at a time — and the alternative
 * is asking for more than will be shown and hoping the slack covers it.
 */
export function historyOf(invoices: readonly Invoice[]): Invoice[] {
  return invoices
    .filter((invoice) => isIssued(invoice.status))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
