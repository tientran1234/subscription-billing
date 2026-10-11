/**
 * Taking somebody out of a workspace.
 *
 * Its own route rather than a verb on the invites one: an invite is an offer
 * that can be withdrawn, and a membership is a person who has access right
 * now. They are released the same seat and nothing else in common.
 *
 * There are no roles, so any member may remove any other — including the
 * person who set the workspace up. That is a consequence of roles not being
 * built rather than a decision about who should be able to do this, and it is
 * written down in the README beside the rest of it.
 */
import type { RemovalRefusal } from "@/domain/invite";
import { removeMember } from "@/server/invites";
import { withSession } from "@/server/with-session";

export const runtime = "nodejs";

const REFUSALS: Record<RemovalRefusal, { status: number; error: string }> = {
  // 404 rather than 403, as everywhere else here: somebody who is not in this
  // workspace is not an id the caller gets to confirm exists.
  not_a_member: { status: 404, error: "no such member" },
  last_member: {
    status: 409,
    error: "the last member cannot be removed — the subscription would be unreachable",
  },
};

export const DELETE = withSession(
  async (_request, { tenantId }, ctx: { params: Promise<{ userId: string }> }) => {
    const { userId } = await ctx.params;
    const result = await removeMember(tenantId, userId);
    if (!result.ok) {
      const refusal = REFUSALS[result.reason];
      // The reason alongside the sentence, as the invite route does it: the
      // page says which refusal it was in the reader's own language.
      return Response.json(
        { error: refusal.error, reason: result.reason },
        { status: refusal.status },
      );
    }
    // The membership was the access: entitlements are derived on read and the
    // session is a row in Postgres, so the person is out on their very next
    // request rather than when a token would have expired.
    return new Response(null, { status: 204 });
  },
);
