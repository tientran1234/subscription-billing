"use client";

import { useState } from "react";
import { isQuoteUsable } from "@/domain/plan-change";

/** A plan this tenant may move to, with its button already translated. */
export interface PlanOffer {
  planKey: string;
  name: string;
  choose: string;
}

/** `/api/plan-change`'s preview, as it survives JSON: the dates are strings. */
interface Quote {
  amountDueMinor: number;
  currency: string;
  prorationDate: string;
  nextInvoiceAt?: string;
}

type State =
  | { step: "idle" }
  | { step: "quoting"; offer: PlanOffer }
  | { step: "quoted"; offer: PlanOffer; quote: Quote }
  | { step: "confirming"; offer: PlanOffer; quote: Quote }
  | { step: "requested" }
  | { step: "failed"; message: string };

export interface PlanPickerLabels {
  heading: string;
  quoting: string;
  dueNow: string;
  dueNothing: string;
  nextInvoice: string;
  holds: string;
  confirm: string;
  confirming: string;
  back: string;
  requested: string;
  inactive: string;
  expired: string;
  changed: string;
  failed: string;
}

/**
 * The two steps of `/api/plan-change` — quote, then confirm — with the amount
 * in front of the customer while they decide.
 *
 * A client component because a proration is priced at an instant: a price
 * rendered with the page would be quoted at page load and stale by the time
 * anyone read it, which is the thing `prorationDate` exists to prevent.
 *
 * Which plans get a button is not decided here. `offers` is what
 * `planChangeOptions` allowed, so the buttons and the route's refusals are one
 * rule rather than two that can drift.
 */
export function PlanPicker({
  offers,
  inactive,
  locale,
  labels,
}: {
  offers: PlanOffer[];
  /** The subscription cannot be prorated against — worth saying, unlike the
   * other refusals, which are evident from the plan the tenant is on. */
  inactive: boolean;
  locale: string;
  labels: PlanPickerLabels;
}) {
  const [state, setState] = useState<State>({ step: "idle" });

  if (offers.length === 0 && !inactive) return null;

  const money = (minor: number, currency: string) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(minor / 100);

  async function quote(offer: PlanOffer) {
    setState({ step: "quoting", offer });
    try {
      const response = await fetch("/api/plan-change", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planKey: offer.planKey }),
      });
      if (response.status === 409) return setState({ step: "failed", message: labels.changed });
      if (!response.ok) return setState({ step: "failed", message: labels.failed });
      setState({ step: "quoted", offer, quote: (await response.json()) as Quote });
    } catch {
      setState({ step: "failed", message: labels.failed });
    }
  }

  async function confirm(offer: PlanOffer, quoted: Quote) {
    // The freshness rule the route runs, run here too, so a customer who left
    // the tab open is told to take a fresh price rather than refused by the
    // server for an amount we showed them in good faith.
    if (!isQuoteUsable(new Date(quoted.prorationDate))) {
      return setState({ step: "failed", message: labels.expired });
    }

    setState({ step: "confirming", offer, quote: quoted });
    try {
      const response = await fetch("/api/plan-change", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planKey: offer.planKey, prorationDate: quoted.prorationDate }),
      });
      if (response.status === 409) return setState({ step: "failed", message: labels.changed });
      if (!response.ok) return setState({ step: "failed", message: labels.failed });
      setState({ step: "requested" });
    } catch {
      setState({ step: "failed", message: labels.failed });
    }
  }

  // Nothing here says the plan has changed, because it has not: the provider
  // has been asked, and the plan moves when the invoice paying for it comes
  // back as a webhook — the same 202 the route answers with.
  if (state.step === "requested") {
    return (
      <section>
        <h2 className="section">{labels.heading}</h2>
        <p className="sub">{labels.requested}</p>
      </section>
    );
  }

  if (state.step === "quoted" || state.step === "confirming") {
    const { offer, quote: quoted } = state;
    const busy = state.step === "confirming";
    return (
      <section>
        <h2 className="section">{offer.name}</h2>
        <div className="quote">
          <dl>
            <dt>{labels.dueNow}</dt>
            {/* A downgrade prorates to a credit rather than a refund: nothing
                is taken now, and the unused time comes off the next invoice. */}
            <dd>
              {quoted.amountDueMinor > 0
                ? money(quoted.amountDueMinor, quoted.currency)
                : labels.dueNothing}
            </dd>
            {quoted.nextInvoiceAt ? (
              <>
                <dt>{labels.nextInvoice}</dt>
                <dd>{quoted.nextInvoiceAt.slice(0, 10)}</dd>
              </>
            ) : null}
          </dl>
          <div className="actions">
            <button className="button" disabled={busy} onClick={() => confirm(offer, quoted)}>
              {busy ? labels.confirming : labels.confirm}
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setState({ step: "idle" })}
            >
              {labels.back}
            </button>
          </div>
        </div>
        <p className="sub">{labels.holds}</p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="section">{labels.heading}</h2>
      {offers.length === 0 ? (
        <p className="sub">{labels.inactive}</p>
      ) : (
        <div className="actions">
          {offers.map((offer) => (
            <button
              key={offer.planKey}
              className="button"
              disabled={state.step === "quoting"}
              onClick={() => quote(offer)}
            >
              {state.step === "quoting" && state.offer.planKey === offer.planKey
                ? labels.quoting
                : offer.choose}
            </button>
          ))}
        </div>
      )}
      {state.step === "failed" ? <p className="sub">{state.message}</p> : null}
    </section>
  );
}
