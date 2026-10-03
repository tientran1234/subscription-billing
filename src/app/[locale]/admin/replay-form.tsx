"use client";

import { useState } from "react";

type State =
  | { step: "idle" }
  | { step: "sending" }
  /** What applyEvent did with it, in its own words — see ApplyOutcome. */
  | { step: "done"; outcome: string }
  | { step: "refused" }
  | { step: "failed" };

export interface ReplayLabels {
  heading: string;
  note: string;
  eventId: string;
  action: string;
  sending: string;
  done: string;
  refused: string;
  failed: string;
}

/**
 * The admin action for a delivery that never arrived: hand the provider's event
 * id back to `/api/replay`, which re-fetches the event and re-applies it.
 *
 * A client component because the answer is the point. A replay reports what it
 * did — applied, or already applied, or too late to change anything — and an
 * operator who cannot see which one has no way to tell a repaired webhook from
 * one that was never missing. Nothing is decided here: the id is the whole
 * request, and what may be done with it is settled server-side against the
 * caller's own workspace.
 */
export function ReplayForm({ labels }: { labels: ReplayLabels }) {
  const [eventId, setEventId] = useState("");
  const [state, setState] = useState<State>({ step: "idle" });

  async function replay() {
    const providerEventId = eventId.trim();
    if (!providerEventId) return;

    setState({ step: "sending" });
    try {
      const response = await fetch("/api/replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerEventId }),
      });
      if (response.status === 404) return setState({ step: "refused" });
      if (!response.ok) return setState({ step: "failed" });
      const { outcome } = (await response.json()) as { outcome: string };
      setState({ step: "done", outcome });
    } catch {
      setState({ step: "failed" });
    }
  }

  const busy = state.step === "sending";

  return (
    <section className="list">
      <h2>{labels.heading}</h2>
      <p className="sub">{labels.note}</p>
      <div className="replay">
        <label>
          {labels.eventId}{" "}
          <input
            value={eventId}
            disabled={busy}
            placeholder="evt_…"
            onChange={(event) => setEventId(event.target.value)}
          />
        </label>
        <button className="button" disabled={busy || !eventId.trim()} onClick={replay}>
          {busy ? labels.sending : labels.action}
        </button>
      </div>
      {state.step === "done" ? (
        <p className="sub">
          {labels.done} {state.outcome}
        </p>
      ) : null}
      {state.step === "refused" ? <p className="sub">{labels.refused}</p> : null}
      {state.step === "failed" ? <p className="sub">{labels.failed}</p> : null}
    </section>
  );
}
