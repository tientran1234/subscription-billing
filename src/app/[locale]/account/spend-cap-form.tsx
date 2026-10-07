"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MAX_SPEND_CAP, type SpendCap } from "@/domain/spend-cap";

export interface SpendCapLabels {
  heading: string;
  /** The field: units past the quota, not money — said in the label. */
  units: string;
  /** What is in force, with the number already in it. */
  current: string;
  /** What is in force when there is no cap at all. */
  uncapped: string;
  save: string;
  saving: string;
  lift: string;
  saved: string;
  invalid: string;
  failed: string;
  note: string;
}

type State = "idle" | "saving" | "saved" | "invalid" | "failed";

/**
 * The ceiling on the metered add-on, as the customer sets it.
 *
 * A client component for the ordinary reason — it is a form — but the cap it
 * states is the one the server read, never a copy kept here: a save refreshes
 * the route and the sentence comes back from the row. The alternative is a
 * figure on the screen that is right until something refuses it, which on a page
 * about what a customer will be billed is the one thing not worth risking.
 *
 * An empty field means no cap, which is a value and not a missing answer: the
 * difference between "bill me nothing past my plan" and "bill me whatever the
 * month comes to" is the whole of what this form says, so zero and empty must
 * not collapse into each other.
 */
export function SpendCapForm({
  cap,
  labels,
}: {
  cap: SpendCap;
  labels: SpendCapLabels;
}) {
  const router = useRouter();
  const [field, setField] = useState(cap === null ? "" : String(cap));
  const [state, setState] = useState<State>("idle");

  async function save(capUnits: SpendCap) {
    setState("saving");
    try {
      const response = await fetch("/api/spend-cap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capUnits }),
      });
      if (response.status === 400) return setState("invalid");
      if (!response.ok) return setState("failed");
      setState("saved");
      // The sentence above is rendered from the row, so this is what moves it.
      router.refresh();
    } catch {
      setState("failed");
    }
  }

  // An empty field is a request to lift the cap; anything else has to be a
  // number before it is worth a round trip. The domain rule is what decides in
  // the end — this only keeps the obvious slip out of the network.
  function submit() {
    const trimmed = field.trim();
    if (trimmed === "") return save(null);
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed)) return setState("invalid");
    return save(parsed);
  }

  const message =
    state === "saved"
      ? labels.saved
      : state === "invalid"
        ? labels.invalid
        : state === "failed"
          ? labels.failed
          : null;

  return (
    <section>
      <h2 className="section">{labels.heading}</h2>
      <p className="sub" style={{ margin: "0 0 12px" }}>
        {cap === null ? labels.uncapped : labels.current}
      </p>
      <p className="cap">
        <label htmlFor="spend-cap">{labels.units}</label>
        <input
          id="spend-cap"
          type="number"
          min={0}
          max={MAX_SPEND_CAP}
          step={1}
          value={field}
          onChange={(event) => {
            setField(event.target.value);
            setState("idle");
          }}
        />
      </p>
      <p className="actions">
        <button className="button" onClick={submit} disabled={state === "saving"}>
          {state === "saving" ? labels.saving : labels.save}
        </button>
        {cap === null ? null : (
          <button
            className="button secondary"
            onClick={() => save(null)}
            disabled={state === "saving"}
          >
            {labels.lift}
          </button>
        )}
        {message ? <span className="sub">{message}</span> : null}
      </p>
      <p className="sub">{labels.note}</p>
    </section>
  );
}
