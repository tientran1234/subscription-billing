/**
 * A paid feature behind three gates, in this order:
 *
 *   1. API key  — who is calling, and may this key call this at all (scope)
 *   2. entitlement — does the tenant's plan include the feature
 *   3. quota    — is there budget left this month
 *
 * All three derive from rows that change on the next webhook or revocation, so
 * a cancelled tenant or a revoked key loses access on the next request — no
 * background job, nothing to fall out of sync.
 */
import { z } from "zod";
import { canUse, quotaFor } from "@/domain/entitlements";
import { entitlementsForTenant } from "@/server/billing.service";
import { meter } from "@/server/usage";
import { withApiKey } from "@/server/with-api-key";

export const runtime = "nodejs";

const Body = z.object({ prompt: z.string().min(1) });

export const POST = withApiKey("assistant:use", async (request, { tenantId }) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400 });

  const entitlements = await entitlementsForTenant(tenantId);
  if (!canUse(entitlements, "assistant")) {
    return Response.json(
      { error: "not included in your plan", planKey: entitlements.planKey },
      { status: 403 },
    );
  }

  const usage = await meter(tenantId, "aiMessages", quotaFor(entitlements, "aiMessages"));
  if (!usage.allowed) {
    return Response.json({ error: "monthly quota exceeded", ...usage }, { status: 429 });
  }

  // Swap this for a real model call. Everything above is the part that has to
  // be right before a model call is worth making.
  return Response.json({
    reply: `(stub) you asked: ${parsed.data.prompt}`,
    planKey: entitlements.planKey,
    quota: usage,
  });
});
