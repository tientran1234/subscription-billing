"use client";

import { useState } from "react";
import { formatMoney } from "@/domain/currency";
import { isQuoteUsable, planChangeOptions, type CurrentPlan } from "@/domain/plan-change";
import { MAX_SEATS, MIN_SEATS } from "@/domain/seats";

/** A plan we sell, with its button already translated. */
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

// The seat count rides along from "quoting" onwards, so a customer who goes
// back to the number field after a quote cannot confirm one count at the price
// of another.
type State =
  | { step: "idle" }
  | { step: "quoting"; offer: PlanOffer }
  | { step: "quoted"; offer: PlanOffer; seats: number; quote: Quote }
  | { step: "confirming"; offer: PlanOffer; seats: number; quote: Quote }
  | { step: "requested" }
  | { step: "failed"; message: string };

export interface PlanPickerLabels {
  heading: string;
  seats: string;
  /** How many seats are occupied — the floor, said out loud when it bites. */
  seatsFloor: string;
  /** The button for a change of seats alone, on the plan already held. */
  changeSeats: string;
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
 * anyone read it, which is the thing `prorationDate` exists to prevent. Seats
 * are the second reason: which plans may be moved to depends on the count the
 * customer is asking for, so the answers have to follow the number field.
 *
 * Which plans get a button is still not decided here. `planChangeOptions` is
 * the rule the route enforces, run over the seats on screen, so the buttons and
 * the route's refusals are one rule rather than two that can drift.
 */
export function PlanPicker({
  current,
  plans,
  locale,
  labels,
}: {
  /** Null for a tenant that has never reached checkout: nothing to change. */
  current: CurrentPlan | null;
  /** Every plan we sell. The rule below says which of them get a button. */
  plans: PlanOffer[];
  locale: string;
  labels: PlanPickerLabels;
}) {
  const [state, setState] = useState<State>({ step: "idle" });
  const [seats, setSeats] = useState(current?.seats ?? MIN_SEATS);

  if (!current) return null;

  const options = planChangeOptions(current, seats);
  const offered = new Set<string>(
    options.filter((option) => option.refusal === null).map((option) => option.planKey),
  );
  const offers = plans.filter((plan) => offered.has(plan.planKey));

  // Worth saying out loud, unlike the other refusals: that the subscription
  // cannot be prorated against at all, and that the seat count has run into the
  // people already holding one. The rest are evident from the plan on screen.
  const inactive = options.some((option) => option.refusal === "not_billable");
  const tooFewSeats = options.some((option) => option.refusal === "seats_in_use");

  async function quote(offer: PlanOffer) {
    setState({ step: "quoting", offer });
    try {
      const response = await fetch("/api/plan-change", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planKey: offer.planKey, seats }),
      });
      if (response.status === 409) return setState({ step: "failed", message: labels.changed });
      if (!response.ok) return setState({ step: "failed", message: labels.failed });
      setState({ step: "quoted", offer, seats, quote: (await response.json()) as Quote });
    } catch {
      setState({ step: "failed", message: labels.failed });
    }
  }

  async function confirm(offer: PlanOffer, quotedSeats: number, quoted: Quote) {
    // The freshness rule the route runs, run here too, so a customer who left
    // the tab open is told to take a fresh price rather than refused by the
    // server for an amount we showed them in good faith.
    if (!isQuoteUsable(new Date(quoted.prorationDate))) {
      return setState({ step: "failed", message: labels.expired });
    }

    setState({ step: "confirming", offer, seats: quotedSeats, quote: quoted });
    try {
      const response = await fetch("/api/plan-change", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planKey: offer.planKey,
          // The count that was quoted, not the one in the field: the price in
          // front of the customer is the price for these seats.
          seats: quotedSeats,
          prorationDate: quoted.prorationDate,
        }),
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
    const { offer, seats: quotedSeats, quote: quoted } = state;
    const busy = state.step === "confirming";
    return (
      <section>
        <h2 className="section">{offer.name}</h2>
        <div className="quote">
          <dl>
            <dt>{labels.seats}</dt>
            <dd>{quotedSeats}</dd>
            <dt>{labels.dueNow}</dt>
            {/* A downgrade prorates to a credit rather than a refund: nothing
                is taken now, and the unused time comes off the next invoice. */}
            <dd>
              {quoted.amountDueMinor > 0
                ? formatMoney(quoted.amountDueMinor, quoted.currency, locale)
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
            <button
              className="button"
              disabled={busy}
              onClick={() => confirm(offer, quotedSeats, quoted)}
            >
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
      {inactive ? (
        <p className="sub">{labels.inactive}</p>
      ) : (
        <>
          <label className="seats">
            {labels.seats}
            <input
              type="number"
              min={MIN_SEATS}
              max={MAX_SEATS}
              value={seats}
              disabled={state.step === "quoting"}
              onChange={(event) => {
                // An emptied field reads back as NaN. Fall back to what is
                // already paid for rather than withdrawing every button while
                // the customer is still typing the number.
                const next = event.target.valueAsNumber;
                setSeats(Number.isNaN(next) ? current.seats : next);
              }}
            />
          </label>
          {tooFewSeats ? <p className="sub">{labels.seatsFloor}</p> : null}
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
                  : offer.planKey === current.planKey
                    ? labels.changeSeats
                    : offer.choose}
              </button>
            ))}
          </div>
        </>
      )}
      {state.step === "failed" ? <p className="sub">{state.message}</p> : null}
    </section>
  );
}
