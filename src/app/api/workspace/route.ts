/**
 * Which workspace a session is acting for: the ones it may choose between, and
 * the choice itself.
 *
 * The one route here that does not go through `withSession`, for the reason it
 * exists. That wrapper's job is to have resolved a tenant before a handler
 * runs, and an account in several workspaces is refused there with a 409 — so
 * a route whose whole subject is answering that 409 has to run in front of it.
 * It reads the session directly, and the memberships it checks a choice
 * against are the session's own: there is no tenant in scope for this one to
 * own, and nothing here acts on a tenant off the body beyond refusing it.
 *
 * The choice is kept in a cookie rather than a column. It belongs to one
 * browser and not to the account — somebody with one workspace open on a
 * laptop and another on a phone is doing two things at once, and a column
 * would make the second switch pull the first one's page out from under it.
 */
import { z } from "zod";
import { resolveTenant } from "@/domain/membership";
import { auth } from "@/lib/auth";
import { workspacesFor } from "@/server/workspaces";
import {
  chosenWorkspaceCookie,
  principalFrom,
  resolveRequestTenant,
} from "@/server/with-session";

export const runtime = "nodejs";

// `.strict()` for the usual reason: a body naming anything else gets a 400
// rather than a field nobody here reads.
const Body = z.object({ tenantId: z.string().min(1) }).strict();

const signInFirst = () => Response.json({ error: "sign in first" }, { status: 401 });

/**
 * The workspaces this session may act for, and which one is in force.
 *
 * Here because of that 409: a caller told to name a workspace with
 * `x-tenant-id` has nowhere else to learn the ids it may name. The browser's
 * picker is rendered from the same read on the server rather than from this.
 */
export async function GET(request: Request): Promise<Response> {
  const principal = principalFrom(await auth());
  if (!principal) return signInFirst();

  const resolved = resolveRequestTenant(principal, request.headers);
  return Response.json({
    workspaces: await workspacesFor(principal),
    // Null where the account has to choose, which is the whole point of the
    // list beside it.
    current: resolved.ok ? resolved.tenantId : null,
  });
}

/**
 * Remember a workspace for this browser.
 *
 * Nothing is written to the database, so there is no role to require: choosing
 * which of your own workspaces you are looking at is not a change to either of
 * them. What stops it being a way in is the membership check below — the same
 * one, with the same opacity, that every other route gets from the wrapper.
 */
export async function POST(request: Request): Promise<Response> {
  const principal = principalFrom(await auth());
  if (!principal) return signInFirst();

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Through the same rule as everywhere else, and refused the same way: a
  // workspace this account does not hold answers exactly like one that does
  // not exist, so a signed-in caller cannot learn which ids are real.
  const resolved = resolveTenant(principal, parsed.data.tenantId);
  if (!resolved.ok) return Response.json({ error: "no access to that tenant" }, { status: 403 });

  return Response.json(
    { tenantId: resolved.tenantId, role: resolved.role },
    { headers: { "set-cookie": chosenWorkspaceCookie(resolved.tenantId) } },
  );
}
