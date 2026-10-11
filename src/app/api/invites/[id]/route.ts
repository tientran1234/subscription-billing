import { revokeInvite } from "@/server/invites";
import { withSession } from "@/server/with-session";

export const runtime = "nodejs";

/** Withdraw an invite, releasing the seat it was holding. */
export const DELETE = withSession(
  async (_request, { tenantId }, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    // An invite belonging to someone else's workspace answers 404, exactly as
    // an API key does: the caller has no business learning that the id exists.
    // One already accepted or withdrawn answers the same — there is no open
    // invite by that id, and the person an accepted one became is removed
    // through the members route instead.
    const revoked = await revokeInvite(id, tenantId);
    if (!revoked) return Response.json({ error: "no such invite" }, { status: 404 });
    return new Response(null, { status: 204 });
  },
  { changesWorkspace: true },
);
