import { describe, expect, it } from "vitest";
import { formatMoney } from "@/domain/currency";
import {
  INVOICE_HISTORY_LIMIT,
  historyOf,
  historyPageOf,
  isIssued,
  type Invoice,
  type InvoiceStatus,
} from "@/domain/invoice";

const invoice = (over: Partial<Invoice> & { id: string }): Invoice => ({
  number: "ACME-0001",
  createdAt: new Date("2026-06-01"),
  status: "paid",
  totalMinor: 2_900,
  currency: "usd",
  hostedUrl: "https://gateway.test/i/one",
  pdfUrl: "https://gateway.test/i/one.pdf",
  ...over,
});

describe("which invoices are history", () => {
  it("keeps every invoice the gateway has issued", () => {
    // `void` and `uncollectible` among them: an invoice that was cancelled or
    // written off is still part of what happened on the account, and dropping
    // it would make a month disappear from the customer's own history.
    const issued: InvoiceStatus[] = ["open", "paid", "void", "uncollectible"];
    for (const status of issued) expect(isIssued(status)).toBe(true);
  });

  it("drops the draft the gateway is still assembling", () => {
    // The one way this list can lie: a draft's total still moves, nobody has
    // been asked to pay it, and there is no document behind it to open — so
    // showing it tells a customer they were charged something they were not.
    expect(isIssued("draft")).toBe(false);

    const history = historyOf([
      invoice({ id: "in_draft", status: "draft", number: null, totalMinor: 9_900 }),
      invoice({ id: "in_paid" }),
    ]);
    expect(history.map((i) => i.id)).toEqual(["in_paid"]);
  });

  it("orders newest first whatever order the gateway listed them in", () => {
    const history = historyOf([
      invoice({ id: "in_may", createdAt: new Date("2026-05-01") }),
      invoice({ id: "in_july", createdAt: new Date("2026-07-01") }),
      invoice({ id: "in_june", createdAt: new Date("2026-06-01") }),
    ]);
    expect(history.map((i) => i.id)).toEqual(["in_july", "in_june", "in_may"]);
  });

  it("keeps a row the gateway offers no document for", () => {
    // The amount and the month are the history; the links are an extra. A row
    // dropped for having no PDF would be a month the customer paid for and
    // cannot see.
    const history = historyOf([invoice({ id: "in_bare", hostedUrl: null, pdfUrl: null })]);
    expect(history).toHaveLength(1);
    expect(history[0].totalMinor).toBe(2_900);
  });

  it("caps nothing of its own", () => {
    // The cap is what the gateway is asked for — see INVOICE_HISTORY_LIMIT.
    // Capping again here would be a second answer to how long the list is, and
    // the two would drift.
    const many = Array.from({ length: INVOICE_HISTORY_LIMIT + 5 }, (_, i) =>
      invoice({ id: `in_${i}`, createdAt: new Date(2026, 0, i + 1) }),
    );
    expect(historyOf(many)).toHaveLength(many.length);
  });

  it("reads a total through the currency's own minor unit", () => {
    // The dong has no subdivision, so a history that divided by a hundred
    // everywhere would quote a Vietnamese customer a hundredth of what they
    // paid. The rule is domain/currency.ts's, and this is the page using it.
    const paid = invoice({ id: "in_vnd", totalMinor: 490_000, currency: "vnd" });
    expect(formatMoney(paid.totalMinor, paid.currency, "vi")).toContain("490.000");
  });
});

describe("where the next window of the archive starts", () => {
  it("has nowhere older to go when the gateway says the window is the last", () => {
    const page = historyPageOf({
      invoices: [invoice({ id: "in_june" })],
      hasMore: false,
    });
    // A link offered here is a link to an empty page: the cursor would be
    // valid and the window behind it would hold nothing.
    expect(page.nextCursor).toBeNull();
    expect(page.invoices.map((i) => i.id)).toEqual(["in_june"]);
  });

  it("continues from the gateway's last row and not from the last row shown", () => {
    // The window the gateway handed back ends on the draft, which never
    // reaches the page. A cursor taken from what is drawn would name the
    // issued invoice above it, and the next window would then open on the
    // draft again — the same row, under a link that said "older", forever.
    const page = historyPageOf({
      invoices: [
        invoice({ id: "in_paid", createdAt: new Date("2026-06-01") }),
        invoice({
          id: "in_draft",
          status: "draft",
          number: null,
          createdAt: new Date("2026-05-01"),
        }),
      ],
      hasMore: true,
    });

    expect(page.invoices.map((i) => i.id)).toEqual(["in_paid"]);
    expect(page.nextCursor).toBe("in_draft");
  });

  it("takes the cursor from the gateway's order rather than from ours", () => {
    // We sort for the page; the cursor is a position in the gateway's own
    // sequence. Reading it off the sorted list would name the oldest invoice
    // in the window instead of the row the window ended on, and the gap
    // between the two is a month of invoices nobody is ever shown.
    const page = historyPageOf({
      invoices: [
        invoice({ id: "in_may", createdAt: new Date("2026-05-01") }),
        invoice({ id: "in_july", createdAt: new Date("2026-07-01") }),
        invoice({ id: "in_june", createdAt: new Date("2026-06-01") }),
      ],
      hasMore: true,
    });

    expect(page.invoices.map((i) => i.id)).toEqual(["in_july", "in_june", "in_may"]);
    expect(page.nextCursor).toBe("in_june");
  });

  it("offers no cursor for a window that came back empty", () => {
    // A gateway claiming more while handing back nothing has given us nowhere
    // to continue from, so the list ends instead of offering a dead link.
    expect(historyPageOf({ invoices: [], hasMore: true }).nextCursor).toBeNull();
  });
});
