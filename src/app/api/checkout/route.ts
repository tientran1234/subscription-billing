import { z } from "zod";
import { isPlanKey } from "@/domain/entitlements";
import { StripeProvider } from "@/providers/stripe";
import { startCheckout } from "@/server/billing.service";
import { withSession } from "@/server/with-session";
import { env, priceRefFor } from "@/lib/env";

export const runtime = "nodejs";

// `.strict()` so a caller still sending `tenantId` gets a 400 instead of
// silently starting a subscription against whichever tenant its session
// resolves to.
const Body = z
  .object({ planKey: z.string().refine(isPlanKey, "unknown plan") })
  .strict();

export const POST = withSession(async (request, { tenantId, email }) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const priceRef = priceRefFor(parsed.data.planKey);
  if (!priceRef) {
    return Response.json({ error: "that plan is not purchasable" }, { status: 400 });
  }

  const e = env();
  const provider = new StripeProvider(e.STRIPE_SECRET_KEY, e.STRIPE_WEBHOOK_SECRET);
  const result = await startCheckout(provider, {
    tenantId,
    planKey: parsed.data.planKey,
    customerEmail: email,
    priceRef,
    appUrl: e.APP_URL,
  });

  return Response.json(result, { status: 201 });
});
