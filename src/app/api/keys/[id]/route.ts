import { revokeApiKey } from "@/server/api-keys";

export const runtime = "nodejs";

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await revokeApiKey(id);
  return new Response(null, { status: 204 });
}
