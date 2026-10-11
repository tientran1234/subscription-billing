/**
 * The people in a workspace: read the roster, or offer a seat to an address.
 *
 * A session rather than an API key, like the spend cap: who may act for a
 * workspace is not something a machine credential should be able to widen. The
 * tenant is the session's own, so an invite cannot be sent into somebody
 * else's workspace however the body is addressed.
 *
 * There is no route to accept one. The invited address signs in the way
 * everybody does and the sign-in events in src/lib/auth.ts turn the open
 * invite into a membership — see src/domain/invite.ts for why an invite here
 * carries no token to hand back.
 */
import { z } from "zod";
import type { InviteOutcome } from "@/server/invites";
import { inviteMember, rosterView } from "@/server/invites";
import { withSession } from "@/server/with-session";
import { env } from "@/lib/env";

export const runtime = "nodejs";

// `.strict()` for the usual reason: a body naming a tenant gets a 400 rather
// than a seat on somebody else's workspace. What a sendable address looks like
// is deliberately left to the domain rule — a copy of it in a schema here is
// the second answer that goes stale, as the spend cap's bounds are.
const Body = z.object({ email: z.string() }).strict();

/**
 * A 409 where the request is well formed and the workspace is in the way,
 * which is every refusal but the malformed address: the caller can see the
 * roster that explains each one.
 */
const REFUSALS: Record<InviteOutcome, { status: number; error: string }> = {
  invalid_email: { status: 400, error: "that is not an address we can send to" },
  already_member: { status: 409, error: "that address is already in this workspace" },
  already_invited: { status: 409, error: "that address already has an invite open" },
  no_seat: { status: 409, error: "every seat this workspace has bought is taken" },
  // 502, not 500: nothing here is broken and the row has already been taken
  // back, so there is no seat held and the same request can be retried.
  send_failed: { status: 502, error: "the invite could not be sent, so no seat is held" },
};

export const GET = withSession(async (_request, { tenantId }) =>
  Response.json(await rosterView(tenantId)),
);

export const POST = withSession(async (request, { tenantId, userId, email }) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await inviteMember({
    tenantId,
    email: parsed.data.email,
    // Off the session, never the body: the row names who offered the seat, and
    // an invite that could claim to be from somebody else is an invite nobody
    // can trust the From line of.
    invitedBy: { userId, email },
    appUrl: env().APP_URL,
  });

  if (!result.ok) {
    const refusal = REFUSALS[result.reason];
    // The reason rides alongside the sentence, because three of these share a
    // 409 and the page has to say which one in the reader's language — off the
    // message files, not by matching on English prose.
    return Response.json(
      { error: refusal.error, reason: result.reason },
      { status: refusal.status },
    );
  }

  // 201: the invite exists and the mail has gone. The membership it becomes is
  // still the invited person's to make, which is what the row is holding a
  // seat for in the meantime.
  return Response.json({ invite: result.invite }, { status: 201 });
});
