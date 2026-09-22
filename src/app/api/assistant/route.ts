/**
 * A paid feature, gated the way every paid feature should be: entitlement check
 * first (does this plan include it at all), quota second (is there budget left
 * this month). Both derive from the subscription, so a cancelled tenant loses
 * access on the next request — no background job, nothing to fall out of sync.
 */
import { z } from "zod";
import { canUse, quotaFor } from "@/domain/entitlements";
import { entitlementsForTenant } from "@/server/billing.service";
import { meter } from "@/server/usage";

export const runtime = "nodejs";

const Body = z.object({ tenantId: z.string().min(1), prompt: z.string().min(1) });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400 });

  const entitlements = await entitlementsForTenant(parsed.data.tenantId);
  if (!canUse(entitlements, "assistant")) {
    return Response.json(
      { error: "not included in your plan", planKey: entitlements.planKey },
      { status: 403 },
    );
  }

  const usage = await meter(
    parsed.data.tenantId,
    "aiMessages",
    quotaFor(entitlements, "aiMessages"),
  );
  if (!usage.allowed) {
    return Response.json(
      { error: "monthly quota exceeded", ...usage },
      { status: 429, headers: { "x-quota-used": String(usage.used) } },
    );
  }

  // Swap this for a real model call. Everything above is the part that has to
  // be right before a model call is worth making.
  return Response.json({
    reply: `(stub) you asked: ${parsed.data.prompt}`,
    planKey: entitlements.planKey,
    quota: usage,
  });
}
