"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { InviteOutcome } from "@/server/invites";
import type { RemovalRefusal } from "@/domain/invite";

/** A person in the workspace, as the server read them. */
export interface PersonRow {
  userId: string;
  email: string;
  /** The signed-in reader, labelled so they can see which row is theirs. */
  isYou: boolean;
}

/** An invite still holding a seat, as the server read it. */
export interface InviteRow {
  id: string;
  email: string;
  /**
   * Who sent it and how long the seat is held, as one sentence the server has
   * already composed in the page's locale.
   *
   * A sentence rather than the two values, because only the server can write
   * it: the date has to be formatted against the locale the URL was fetched
   * with and not the one this browser happens to be set to, and which order
   * the inviter and the date read in is the message file's business. Composing
   * it here would also mean handing this component a function to call, which a
   * server component may not pass across the boundary at all.
   */
  detail: string;
}

export interface PeopleLabels {
  heading: string;
  /** Seats taken out of seats bought, with both numbers already in it. */
  seats: string;
  members: string;
  invited: string;
  you: string;
  field: string;
  invite: string;
  inviting: string;
  sent: string;
  remove: string;
  removing: string;
  withdraw: string;
  /** Said where the form would be, when there is no seat to offer. */
  full: string;
  failed: string;
  note: string;
  /**
   * One sentence per way the server can refuse, keyed by the reason it sends
   * back. Written out by the page rather than folded over the union, so a
   * refusal added to either rule is a compile error there instead of a form
   * that fails silently here.
   */
  refusals: Record<InviteOutcome | RemovalRefusal, string>;
}

type State =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "sent" }
  | { kind: "refused"; reason: keyof PeopleLabels["refusals"] }
  | { kind: "failed" };

/**
 * Who is in this workspace, who has been offered a seat, and the one form that
 * offers another.
 *
 * Both lists come from the server on every render and none of it is kept here.
 * A seat is the thing this page is also about buying, so a roster that drifted
 * from the row would be a count the customer reasons about their bill with —
 * and the refusal they would meet is the one the plan picker above shows the
 * floor for.
 *
 * The invite form disappears when every seat is taken, rather than being
 * offered and refused: the seats are bought immediately above, so the answer
 * to a full workspace is a sentence pointing there and not a round trip that
 * says no.
 */
export function People({
  members,
  invites,
  seats,
  labels,
}: {
  members: PersonRow[];
  invites: InviteRow[];
  seats: number;
  labels: PeopleLabels;
}) {
  const router = useRouter();
  const [field, setField] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  const taken = members.length + invites.length;

  /**
   * Every write here goes the same way: ask, then let the server say what the
   * lists are. A refusal carries its reason so the sentence is this page's to
   * pick in the reader's language.
   */
  async function send(request: () => Promise<Response>, done: State) {
    setState({ kind: "working" });
    try {
      const response = await request();
      if (response.ok) {
        setState(done);
        setField("");
        // The lists above are rendered from the rows, so this is what moves
        // them — and what makes the seat count agree with the one the plan
        // picker enforces.
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as { reason?: string } | null;
      const reason = body?.reason;
      if (reason && reason in labels.refusals) {
        setState({ kind: "refused", reason: reason as keyof PeopleLabels["refusals"] });
        return;
      }
      setState({ kind: "failed" });
    } catch {
      setState({ kind: "failed" });
    }
  }

  const invite = () =>
    send(
      () =>
        fetch("/api/invites", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: field }),
        }),
      { kind: "sent" },
    );

  const withdraw = (id: string) =>
    send(() => fetch(`/api/invites/${id}`, { method: "DELETE" }), { kind: "idle" });

  const remove = (userId: string) =>
    send(() => fetch(`/api/members/${userId}`, { method: "DELETE" }), { kind: "idle" });

  const working = state.kind === "working";
  const message =
    state.kind === "sent"
      ? labels.sent
      : state.kind === "refused"
        ? labels.refusals[state.reason]
        : state.kind === "failed"
          ? labels.failed
          : null;

  return (
    <section>
      <h2 className="section">{labels.heading}</h2>
      <p className="sub" style={{ margin: "0 0 12px" }}>
        {labels.seats}
      </p>

      <table className="rows">
        <thead>
          <tr>
            <th>{labels.members}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId}>
              <td>
                {member.email}
                {member.isYou ? <span className="sub"> ({labels.you})</span> : null}
              </td>
              <td className="num">
                {/* The last member is refused by the server too; the button is
                    withheld so the only way to meet that refusal is a request
                    this page did not draw. */}
                {members.length > 1 ? (
                  <button
                    className="button secondary"
                    onClick={() => remove(member.userId)}
                    disabled={working}
                  >
                    {working ? labels.removing : labels.remove}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {invites.length === 0 ? null : (
        <table className="rows">
          <thead>
            <tr>
              <th>{labels.invited}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invites.map((pending) => (
              <tr key={pending.id}>
                <td>
                  {pending.email}
                  <span className="sub"> — {pending.detail}</span>
                </td>
                <td className="num">
                  <button
                    className="button secondary"
                    onClick={() => withdraw(pending.id)}
                    disabled={working}
                  >
                    {labels.withdraw}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {taken >= seats ? (
        <p className="sub">{labels.full}</p>
      ) : (
        <p className="invite">
          <label htmlFor="invite-email">{labels.field}</label>
          <input
            id="invite-email"
            type="email"
            autoComplete="off"
            value={field}
            onChange={(event) => {
              setField(event.target.value);
              setState({ kind: "idle" });
            }}
          />
        </p>
      )}

      <p className="actions">
        {taken >= seats ? null : (
          <button className="button" onClick={invite} disabled={working || field.trim() === ""}>
            {working ? labels.inviting : labels.invite}
          </button>
        )}
        {message ? <span className="sub">{message}</span> : null}
      </p>
      <p className="sub">{labels.note}</p>
    </section>
  );
}
