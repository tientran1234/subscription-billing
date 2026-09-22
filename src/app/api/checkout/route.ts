import { z } from "zod";
import { isPlanKey } from "@/domain/entitlements";
import { StripeProvider } from "@/providers/stripe";
import { startCheckout } from "@/server/billing.service";
import { env, priceRefFor } from "@/lib/env";

export const runtime = "nodejs";

const Body = z.object({
  tenantId: z.string().min(1),
  planKey: z.string().refine(isPlanKey, "unknown plan"),
  customerEmail: z.string().email().optional(),
});

export async function POST(request: Request) {
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
    ...parsed.data,
    priceRef,
    appUrl: e.APP_URL,
  });

  return Response.json(result, { status: 201 });
}
