import { z } from "zod";
import { isPlanKey } from "@/domain/entitlements";
import { StripeProvider } from "@/providers/stripe";
import {
  confirmPlanChange,
  previewPlanChange,
  type PlanChangeFailure,
} from "@/server/billing.service";
import { withSession } from "@/server/with-session";
import { env, priceRefFor } from "@/lib/env";

export const runtime = "nodejs";

// One endpoint, two steps: a body with no quote in it asks what the change
// would cost, a body echoing the quote asks for the change itself. Both are
// `.strict()`, so a caller sending `tenantId` gets a 400 rather than a plan
// change on someone else's subscription.
const PlanKey = z.string().refine(isPlanKey, "unknown plan");
const Preview = z.object({ planKey: PlanKey }).strict();
const Confirm = z
  .object({ planKey: PlanKey, prorationDate: z.string().datetime() })
  .strict();
const Body = z.union([Confirm, Preview]);

/** Why the refusal is the customer's to fix, or ours to explain. */
const REFUSALS: Record<PlanChangeFailure, { status: number; error: string }> = {
  unknown_plan: { status: 400, error: "unknown plan" },
  not_purchasable: { status: 400, error: "that plan is not purchasable — cancel in the portal instead" },
  no_subscription: { status: 409, error: "no subscription to change yet" },
  not_billable: { status: 409, error: "only an active subscription can change plan" },
  same_plan: { status: 409, error: "already on that plan" },
  stale_quote: { status: 409, error: "that price is out of date — preview again" },
};

const refuse = (reason: PlanChangeFailure) =>
  Response.json({ error: REFUSALS[reason].error }, { status: REFUSALS[reason].status });

export const POST = withSession(async (request, { tenantId }) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { planKey } = parsed.data;
  const priceRef = priceRefFor(planKey);
  if (!priceRef) return refuse("not_purchasable");

  const e = env();
  const provider = new StripeProvider(e.STRIPE_SECRET_KEY, e.STRIPE_WEBHOOK_SECRET);

  if (!("prorationDate" in parsed.data)) {
    const result = await previewPlanChange(provider, { tenantId, planKey, priceRef });
    if (!result.ok) return refuse(result.reason);
    return Response.json(result.preview);
  }

  const result = await confirmPlanChange(provider, {
    tenantId,
    planKey,
    priceRef,
    prorationDate: new Date(parsed.data.prorationDate),
  });
  if (!result.ok) return refuse(result.reason);

  // 202, not 200: the provider has been asked, and the plan moves here when the
  // invoice paying for it comes back as a webhook. Saying 200 would claim a
  // change that a declined card still has to make true.
  return Response.json({ status: "requested" }, { status: 202 });
});
