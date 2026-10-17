"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  MAX_CAP_WARNING_PCT,
  MIN_CAP_WARNING_PCT,
  type CapWarningAt,
} from "@/domain/cap-warning";

export interface CapWarningLabels {
  heading: string;
  /** The field: a percentage of the cap above, not a number of units. */
  field: string;
  /** Where the first mail goes out, with the percentage already in it. */
  current: string;
  /** The same, for a workspace that has never chosen and takes the default. */
  byDefault: string;
  /** What the line is worth on a workspace that set no ceiling at all. */
  noCap: string;
  save: string;
  saving: string;
  reset: string;
  saved: string;
  invalid: string;
  failed: string;
  note: string;
}

type State = "idle" | "saving" | "saved" | "invalid" | "failed";

/**
 * How much of its ceiling a workspace may spend before the first mail, as the
 * customer sets it.
 *
 * Beside the cap rather than inside it, because the two are set at different
 * moments: the ceiling moves when the month's budget does, and this moves once,
 * when a customer finds out that four fifths was more warning than they needed
 * or less than they could act on.
 *
 * An empty field is the default rather than a line at nothing — the setting has
 * no "off", since a cap that stops serving calls without warning is the thing
 * the mail exists to prevent. That is the one way this field differs from the
 * cap's above, where empty means no cap at all, so the note says which it is.
 */
export function CapWarningForm({
  warnAt,
  capped,
  labels,
}: {
  warnAt: CapWarningAt;
  /** Whether there is a ceiling for the line to sit under. */
  capped: boolean;
  labels: CapWarningLabels;
}) {
  const router = useRouter();
  const [field, setField] = useState(warnAt === null ? "" : String(warnAt));
  const [state, setState] = useState<State>("idle");

  async function save(warnAtPct: CapWarningAt) {
    setState("saving");
    try {
      const response = await fetch("/api/cap-warning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warnAtPct }),
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

  // An empty field asks for the default back; anything else has to be a number
  // before it is worth a round trip. The domain rule is what decides in the end
  // — this only keeps the obvious slip out of the network.
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
        {!capped ? labels.noCap : warnAt === null ? labels.byDefault : labels.current}
      </p>
      <p className="cap">
        <label htmlFor="cap-warning">{labels.field}</label>
        <input
          id="cap-warning"
          type="number"
          min={MIN_CAP_WARNING_PCT}
          max={MAX_CAP_WARNING_PCT}
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
        {warnAt === null ? null : (
          <button
            className="button secondary"
            onClick={() => save(null)}
            disabled={state === "saving"}
          >
            {labels.reset}
          </button>
        )}
        {message ? <span className="sub">{message}</span> : null}
      </p>
      <p className="sub">{labels.note}</p>
    </section>
  );
}
