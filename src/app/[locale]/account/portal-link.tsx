"use client";

import { useState } from "react";

type State = "idle" | "opening" | "empty" | "failed";

/**
 * The only interactive piece in the app, and it is a client component for one
 * reason: a portal link is minted per click. The provider's URL is single-use
 * and expires within minutes, so rendering one into the page would hand out a
 * link that is usually dead by the time anyone clicks it.
 */
export function PortalLink({
  label,
  opening,
  empty,
  failed,
}: {
  label: string;
  opening: string;
  empty: string;
  failed: string;
}) {
  const [state, setState] = useState<State>("idle");

  async function open() {
    setState("opening");
    try {
      const response = await fetch("/api/portal", { method: "POST" });
      if (response.status === 409) return setState("empty");
      if (!response.ok) return setState("failed");
      const { portalUrl } = (await response.json()) as { portalUrl: string };
      // A full navigation, not a new tab: the portal sends the customer back
      // to this page when they are done.
      window.location.href = portalUrl;
    } catch {
      setState("failed");
    }
  }

  return (
    <p>
      <button className="button" onClick={open} disabled={state === "opening"}>
        {state === "opening" ? opening : label}
      </button>
      {state === "empty" || state === "failed" ? (
        <span className="sub"> {state === "empty" ? empty : failed}</span>
      ) : null}
    </p>
  );
}
