import { z } from "zod";
import { CURRENCIES, isCurrency, type CurrencyRefusal } from "@/domain/currency";
import { isPlanKey } from "@/domain/entitlements";
import { MAX_SEATS, MIN_SEATS, type SeatRefusal } from "@/domain/seats";
import { billingProvider } from "@/providers";
import { startCheckout } from "@/server/billing.service";
import { withSession } from "@/server/with-session";
import { env, priceRefFor } from "@/lib/env";

export const runtime = "nodejs";

// `.strict()` so a caller still sending `tenantId` gets a 400 instead of
// silently starting a subscription against whichever tenant its session
// resolves to.
const Body = z
  .object({
    planKey: z.string().refine(isPlanKey, "unknown plan"),
    // Optional, because one person buying for themselves is the common
    // checkout. The bounds are the domain's, so this route cannot sell a count
    // the plan picker would refuse.
    seats: z.number().int().min(MIN_SEATS).max(MAX_SEATS).optional(),
    // Optional too: a client that names none is billed in the default. Which
    // currencies exist is the domain's answer, so this route cannot open a
    // session at a price no plan has.
    currency: z.string().refine(isCurrency, "unsupported currency").optional(),
  })
  .strict();

/** A 409 for the floor: the request is well formed, the workspace is in the way. */
const REFUSALS: Record<SeatRefusal | CurrencyRefusal, { status: number; error: string }> = {
  invalid_seats: { status: 400, error: `seats must be a whole number, at most ${MAX_SEATS}` },
  seats_in_use: {
    status: 409,
    error: "that is fewer seats than this workspace has members",
  },
  unsupported_currency: {
    status: 400,
    error: `currency must be one of ${CURRENCIES.join(", ")}`,
  },
};

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
  const provider = billingProvider();
  const result = await startCheckout(provider, {
    tenantId,
    planKey: parsed.data.planKey,
    seats: parsed.data.seats,
    currency: parsed.data.currency,
    customerEmail: email,
    priceRef,
    appUrl: e.APP_URL,
  });
  if (!result.ok) {
    const refusal = REFUSALS[result.reason];
    return Response.json({ error: refusal.error }, { status: refusal.status });
  }

  return Response.json(
    { subscriptionId: result.subscriptionId, checkoutUrl: result.checkoutUrl },
    { status: 201 },
  );
});
