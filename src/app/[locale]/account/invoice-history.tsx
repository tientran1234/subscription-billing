import Link from "next/link";
import { formatMoney } from "@/domain/currency";
import type { InvoiceStatus } from "@/domain/invoice";
import type { InvoiceHistoryResult } from "@/server/billing.service";

/** Server-rendered dates, so there is no locale to disagree with the client. */
const day = (date: Date) => date.toISOString().slice(0, 10);

export interface InvoiceHistoryLabels {
  heading: string;
  empty: string;
  /** What stands in for the table at the far end of the archive. */
  end: string;
  unavailable: string;
  older: string;
  latest: string;
  note: string;
  date: string;
  number: string;
  status: string;
  total: string;
  document: string;
  view: string;
  pdf: string;
  statuses: Record<InvoiceStatus, string>;
}

/**
 * The invoices this workspace has been issued, as the provider holds them.
 *
 * Not a client component, and that is the difference from the portal link
 * beside it: a portal url is minted per click because the provider's is
 * single-use and dead within minutes, whereas a hosted invoice and its PDF
 * live on the invoice itself. So these can be rendered straight into the page —
 * read on this request, rendered once, and copied nowhere.
 *
 * The rows come in already filtered and ordered by domain/invoice.ts. This
 * draws them, and the only judgement left here is a row the provider hosts no
 * document for: it still shows, because the month and the amount are the
 * history and the link is an extra. Dropping it would hide a month the
 * customer paid for.
 *
 * `older` and `latest` arrive built rather than assembled here, so the one
 * place that knows this page's url stays the page itself. Forward and back to
 * the start, like the transaction lists: the gateway's cursor only points one
 * way, and a trail of every window visited would have to ride in the url to
 * walk back through it.
 */
export function InvoiceHistory({
  history,
  locale,
  older,
  latest,
  labels,
}: {
  history: InvoiceHistoryResult;
  locale: string;
  /** Where the next window of older invoices is, or null on the last one. */
  older: string | null;
  /** Back to the newest window — null when this is already it. */
  latest: string | null;
  labels: InvoiceHistoryLabels;
}) {
  const rows = history.ok ? history.invoices : [];

  // What stands in for the table. A provider that could not be read says so
  // rather than reading as a workspace that has never been billed: "no
  // invoices" is the one wrong answer here, because it is also exactly what a
  // customer who has twelve of them would be shown.
  //
  // So is "never been billed" on a window past the end of the archive: the
  // customer reading it has invoices, and has just paged behind the last of
  // them. `latest` is what says which of the two this is.
  const instead = !history.ok
    ? history.reason === "unavailable"
      ? labels.unavailable
      : labels.empty
    : latest
      ? labels.end
      : labels.empty;

  return (
    <section className="list" id="invoices">
      <h2>{labels.heading}</h2>

      {rows.length === 0 ? (
        <p className="sub">{instead}</p>
      ) : (
        <table className="rows">
          <thead>
            <tr>
              <th>{labels.date}</th>
              <th>{labels.number}</th>
              <th>{labels.status}</th>
              <th className="num">{labels.total}</th>
              <th>{labels.document}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((invoice) => (
              <tr key={invoice.id}>
                <td>{day(invoice.createdAt)}</td>
                {/* A finalized invoice always carries a number; the id is what
                    is left to name it by if one ever does not. */}
                <td>{invoice.number ?? invoice.id}</td>
                <td>{labels.statuses[invoice.status]}</td>
                {/* Through the currency's own minor unit — the dong has no
                    subdivision, and a flat hundred would quote a hundredth. */}
                <td className="num">
                  {formatMoney(invoice.totalMinor, invoice.currency, locale)}
                </td>
                <td>
                  {invoice.hostedUrl ? (
                    <a href={invoice.hostedUrl} rel="noreferrer noopener" target="_blank">
                      {labels.view}
                    </a>
                  ) : null}
                  {invoice.hostedUrl && invoice.pdfUrl ? " · " : null}
                  {invoice.pdfUrl ? (
                    <a href={invoice.pdfUrl} rel="noreferrer noopener" target="_blank">
                      {labels.pdf}
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rows.length > 0 ? <p className="sub">{labels.note}</p> : null}

      {older || latest ? (
        <p className="filters">
          {older ? <Link href={older}>{labels.older}</Link> : null}
          {latest ? <Link href={latest}>{labels.latest}</Link> : null}
        </p>
      ) : null}
    </section>
  );
}
