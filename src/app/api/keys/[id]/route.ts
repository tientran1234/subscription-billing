import { revokeApiKey } from "@/server/api-keys";
import { withSession } from "@/server/with-session";

export const runtime = "nodejs";

export const DELETE = withSession(
  async (_request, { tenantId }, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    // A key belonging to someone else's tenant answers 404, not 403: the
    // caller has no business learning that the id exists.
    const revoked = await revokeApiKey(id, tenantId);
    if (!revoked) return Response.json({ error: "no such key" }, { status: 404 });
    return new Response(null, { status: 204 });
  },
);
