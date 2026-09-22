import { z } from "zod";
import { isScope } from "@/domain/api-key";
import { createApiKey } from "@/server/api-keys";

export const runtime = "nodejs";

const Body = z.object({
  tenantId: z.string().min(1),
  env: z.enum(["live", "test"]).default("test"),
  scopes: z.array(z.string().refine(isScope, "unknown scope")).min(1),
  quotaLimit: z.number().int().positive().optional(),
});

/**
 * Mint a key. The raw key appears in this response and nowhere else — the
 * database holds only its hash.
 *
 * Who may mint keys for a tenant is a session-auth question (see README:
 * "What is deliberately not here"); here the tenant id is taken from the body.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid body", details: parsed.error.flatten() }, { status: 400 });
  }
  const { raw, key } = await createApiKey(parsed.data);
  return Response.json(
    { apiKey: raw, key, warning: "store this key now — it is not shown again" },
    { status: 201 },
  );
}
