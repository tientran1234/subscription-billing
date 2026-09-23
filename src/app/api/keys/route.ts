import { z } from "zod";
import { isScope } from "@/domain/api-key";
import { createApiKey } from "@/server/api-keys";
import { withSession } from "@/server/with-session";

export const runtime = "nodejs";

// See the checkout route on `.strict()`: minting a key against the wrong
// tenant hands out access, so a stale `tenantId` field fails loudly.
const Body = z
  .object({
    env: z.enum(["live", "test"]).default("test"),
    scopes: z.array(z.string().refine(isScope, "unknown scope")).min(1),
    quotaLimit: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Mint a key. The raw key appears in this response and nowhere else — the
 * database holds only its hash.
 *
 * The tenant comes from the session's memberships, so a signed-in user can
 * only ever mint keys for a tenant they belong to.
 */
export const POST = withSession(async (request, { tenantId }) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid body", details: parsed.error.flatten() }, { status: 400 });
  }
  const { raw, key } = await createApiKey({ ...parsed.data, tenantId });
  return Response.json(
    { apiKey: raw, key, warning: "store this key now — it is not shown again" },
    { status: 201 },
  );
});
