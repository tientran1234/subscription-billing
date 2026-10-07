/**
 * The ceiling a workspace sets on its own metered add-on: read it, or move it.
 *
 * A session rather than an API key, unlike the overage job next door: this is a
 * customer deciding what they are willing to be billed, which is the account
 * page's business and not a scheduler's. The tenant is the session's own, as it
 * is everywhere else here.
 *
 * Nothing is sent to the gateway, because the gateway has no idea a cap exists.
 * It meters whatever it is told, and the cap is what decides what it is told —
 * see the clamp in src/server/usage-report.ts.
 */
import { z } from "zod";
import { MAX_SPEND_CAP, checkSpendCap } from "@/domain/spend-cap";
import { setSpendCap, spendCapFor } from "@/server/spend-cap";
import { withSession } from "@/server/with-session";

export const runtime = "nodejs";

// `null` is a value a caller sends on purpose — it lifts the cap — so it is in
// the schema rather than left to an omitted field, which would be a caller that
// forgot to say what it wanted. The bounds are deliberately NOT repeated here:
// what a settable cap is belongs to the domain rule, and a copy of it in a
// schema is the second answer that goes stale. `.strict()` for the usual
// reason — a body naming a tenant gets a 400, not a cap on someone else's
// workspace.
const Body = z.object({ capUnits: z.number().nullable() }).strict();

export const GET = withSession(async (_request, { tenantId }) =>
  Response.json({ capUnits: await spendCapFor(tenantId) }),
);

export const POST = withSession(async (request, { tenantId }) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { capUnits } = parsed.data;
  if (checkSpendCap(capUnits)) {
    return Response.json(
      { error: `the cap must be a whole number of units, at most ${MAX_SPEND_CAP}` },
      { status: 400 },
    );
  }

  await setSpendCap(tenantId, capUnits);
  // 200 rather than the 202 a plan change answers with: there is nothing to
  // wait for here. A cap is ours, so it is in force for the very next request,
  // and no invoice has to be paid to make it true.
  return Response.json({ capUnits });
});
