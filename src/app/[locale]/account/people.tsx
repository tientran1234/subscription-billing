"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { InviteOutcome } from "@/server/invites";
import type { RemovalRefusal } from "@/domain/invite";
import { isLastAdmin, type Role } from "@/domain/role";

/** A person in the workspace, as the server read them. */
export interface PersonRow {
  userId: string;
  email: string;
  /** What they may do here, which is also what the controls beside them are. */
  role: Role;
  /** The signed-in reader, labelled so they can see which row is theirs. */
  isYou: boolean;
}

/** An invite still holding a seat, as the server read it. */
export interface InviteRow {
  id: string;
  email: string;
  /** The role the seat was offered in, so the list says what is on its way. */
  role: Role;
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
  /** On the reader's own row, where removal is leaving rather than removing. */
  leave: string;
  removing: string;
  withdraw: string;
  /** What each role is called, written out so adding one is a compile error. */
  roles: Record<Role, string>;
  /** The button that hands the role over, and the one that takes it back. */
  makeAdmin: string;
  makeMember: string;
  savingRole: string;
  /** Beside the invite field: what the seat being offered will be able to do. */
  inviteRole: string;
  /** Said in place of every control, to somebody who may only read. */
  readOnly: string;
  /** Said where the form would be, when there is no seat to offer. */
  full: string;
  failed: string;
  note: string;
  /**
   * One sentence per way the server can refuse, keyed by the reason it sends
   * back. Written out by the page rather than folded over the union, so a
   * refusal added to either rule is a compile error there instead of a form
   * that fails silently here.
   *
   * `not_an_admin` is the route wrapper's rather than either rule's: the
   * controls that would meet it are withheld below, so it is the answer to a
   * request this page did not draw — a role changed in another tab, most
   * likely, which is worth a sentence rather than "that did not go through".
   */
  refusals: Record<InviteOutcome | RemovalRefusal | "not_an_admin", string>;
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
 *
 * Every control a role does not license disappears the same way. A member sees
 * the whole roster — it is the bill they are sharing — and no button on it but
 * the one that lets them leave, which is not an administrative act. The server
 * refuses all of it again regardless: the controls are withheld so that a
 * refusal means a request this page did not draw, not so that withholding them
 * is what stops it.
 */
export function People({
  members,
  invites,
  seats,
  canAdminister,
  labels,
}: {
  members: PersonRow[];
  invites: InviteRow[];
  seats: number;
  /** Whether the reader's role lets them change any of this. */
  canAdminister: boolean;
  labels: PeopleLabels;
}) {
  const router = useRouter();
  const [field, setField] = useState("");
  const [role, setRole] = useState<Role>("member");
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
          body: JSON.stringify({ email: field, role }),
        }),
      { kind: "sent" },
    );

  const setMemberRole = (userId: string, next: Role) =>
    send(
      () =>
        fetch(`/api/members/${userId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: next }),
        }),
      { kind: "idle" },
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
          {members.map((member) => {
            // Every refusal the server has is also a control withheld here, so
            // the only way to meet one is a request this page did not draw.
            // The last admin may not be demoted or removed, the last member may
            // not be removed, and leaving is the one of these a member may do.
            const last = isLastAdmin(member.userId, members);
            const mayRemove = member.isYou || canAdminister;
            return (
              <tr key={member.userId}>
                <td>
                  {member.email}
                  {member.isYou ? <span className="sub"> ({labels.you})</span> : null}
                  <span className="sub"> — {labels.roles[member.role]}</span>
                </td>
                <td className="num">
                  {canAdminister && !last ? (
                    <button
                      className="button secondary"
                      onClick={() =>
                        setMemberRole(member.userId, member.role === "admin" ? "member" : "admin")
                      }
                      disabled={working}
                    >
                      {working
                        ? labels.savingRole
                        : member.role === "admin"
                          ? labels.makeMember
                          : labels.makeAdmin}
                    </button>
                  ) : null}{" "}
                  {members.length > 1 && mayRemove && !last ? (
                    <button
                      className="button secondary"
                      onClick={() => remove(member.userId)}
                      disabled={working}
                    >
                      {working ? labels.removing : member.isYou ? labels.leave : labels.remove}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
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
                  <span className="sub">
                    {" "}
                    — {labels.roles[pending.role]}, {pending.detail}
                  </span>
                </td>
                <td className="num">
                  {canAdminister ? (
                    <button
                      className="button secondary"
                      onClick={() => withdraw(pending.id)}
                      disabled={working}
                    >
                      {labels.withdraw}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* A member is told what they are looking at rather than shown a form
          they would be refused: the seats are bought above and the people are
          listed here, and both are theirs to read. */}
      {!canAdminister ? (
        <p className="sub">{labels.readOnly}</p>
      ) : taken >= seats ? (
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
          <label htmlFor="invite-role">{labels.inviteRole}</label>
          <select
            id="invite-role"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            <option value="member">{labels.roles.member}</option>
            <option value="admin">{labels.roles.admin}</option>
          </select>
        </p>
      )}

      <p className="actions">
        {canAdminister && taken < seats ? (
          <button className="button" onClick={invite} disabled={working || field.trim() === ""}>
            {working ? labels.inviting : labels.invite}
          </button>
        ) : null}
        {message ? <span className="sub">{message}</span> : null}
      </p>
      <p className="sub">{labels.note}</p>
    </section>
  );
}
