"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Role } from "@/domain/role";

/** A workspace this account may act for, as the server named it. */
export interface WorkspaceRow {
  tenantId: string;
  name: string;
  /** What the account may do there, so the list says what choosing one gets. */
  role: Role;
  /** The one this request resolved to, or none of them when it is asking. */
  isCurrent: boolean;
}

export interface WorkspacePickerLabels {
  heading: string;
  /** Under the heading when nothing is in force: why there is a choice at all. */
  ask: string;
  /** Under the heading when one is: what the page below is showing. */
  showing: string;
  open: string;
  opening: string;
  current: string;
  /** What each role is called, written out so adding one is a compile error. */
  roles: Record<Role, string>;
  failed: string;
}

/**
 * Which workspace this browser is looking at.
 *
 * One component for the two things that are the same question. With nothing in
 * force it is the whole of the screen: an account invited into a second
 * workspace has two memberships and no way to resolve between them, and the
 * rule that says so has always said `ambiguous` — this is what acts on it.
 * With one in force it is a section near the top of the account page, which is
 * the way back: a choice you cannot change is a worse answer than no choice.
 *
 * Choosing navigates nothing and keeps nothing. The whole page below is read
 * for one workspace, so the refresh is the point — the cookie the request just
 * set is what the next render resolves from, and a piece of state here would
 * be a second answer to which workspace the figures on the page belong to.
 */
export function WorkspacePicker({
  workspaces,
  labels,
}: {
  workspaces: WorkspaceRow[];
  labels: WorkspacePickerLabels;
}) {
  const router = useRouter();
  const [opening, setOpening] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function open(tenantId: string) {
    setOpening(tenantId);
    setFailed(false);
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      if (!response.ok) {
        setFailed(true);
        setOpening(null);
        return;
      }
      // Left disabled on the way out: the refresh is a round trip, and a button
      // that came back to life in the middle of it would invite a second click
      // on a page that is already being replaced.
      router.refresh();
    } catch {
      setFailed(true);
      setOpening(null);
    }
  }

  const current = workspaces.find((workspace) => workspace.isCurrent);

  return (
    <section>
      <h2 className="section">{labels.heading}</h2>
      <p className="sub" style={{ margin: "0 0 12px" }}>
        {current ? labels.showing : labels.ask}
      </p>
      <table className="rows">
        <tbody>
          {workspaces.map((workspace) => (
            <tr key={workspace.tenantId}>
              <td>{workspace.name}</td>
              <td>{labels.roles[workspace.role]}</td>
              <td>
                {workspace.isCurrent ? (
                  <span className="sub">{labels.current}</span>
                ) : (
                  <button
                    className="button secondary"
                    onClick={() => open(workspace.tenantId)}
                    disabled={opening !== null}
                  >
                    {opening === workspace.tenantId ? labels.opening : labels.open}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {failed ? <p className="sub">{labels.failed}</p> : null}
    </section>
  );
}
