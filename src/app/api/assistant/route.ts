/**
 * A paid feature behind three gates, in this order:
 *
 *   1. API key  — who is calling, and may this key call this at all (scope)
 *   2. entitlement — does the tenant's plan include the feature
 *   3. quota    — is there budget left this month, or is it billable past it,
 *                  and if it is billable, is the workspace still inside the
 *                  ceiling it set for itself — which it is also written to
 *                  about, once, as that ceiling comes up and again at it
 *
 * All three derive from rows that change on the next webhook or revocation, so
 * a cancelled tenant or a revoked key loses access on the next request — no
 * background job, nothing to fall out of sync.
 */
import { z } from "zod";
import { canUse, quotaFor } from "@/domain/entitlements";
import { OVERAGE_QUOTA, overageUnits } from "@/domain/overage";
import { withinSpendCap } from "@/domain/spend-cap";
import { entitlementsForTenant } from "@/server/billing.service";
import { notifyCapWarning } from "@/server/cap-warning";
import { spendCapFor } from "@/server/spend-cap";
import { meter } from "@/server/usage";
import { withApiKey } from "@/server/with-api-key";
import { env } from "@/lib/env";

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

  const usage = await meter(tenantId, OVERAGE_QUOTA, quotaFor(entitlements, OVERAGE_QUOTA));
  const overage = overageUnits(usage.used, usage.limit);

  if (!usage.allowed) {
    // The quota is the end of it unless the subscription carries the metered
    // add-on, in which case the call goes through and what it costs is billed:
    // the units past the quota are reported to the provider once the month has
    // closed, by the job in src/server/usage-report.ts. The entitlement is what
    // decides, so a workspace that stops paying stops being let past the quota
    // in the same instant it stops being billed for going past it.
    if (!entitlements.meteredOverage) {
      return Response.json({ error: "monthly quota exceeded", ...usage }, { status: 429 });
    }

    // Billable, and past the ceiling this workspace put on what it is willing
    // to be billed — so refused rather than charged for. A separate error from
    // the one above because it is a separate thing to do about it: the quota is
    // raised by changing plan, and this by raising a cap the customer owns.
    //
    // The unit has been counted by now, and deliberately so: the counter is
    // what the month is billed from, and a call that skipped it to stay honest
    // about the refusal would be a call the next cap check cannot see. What
    // keeps it off the invoice is the clamp in the report, not this branch.
    const cap = await spendCapFor(tenantId);

    // Before the refusal, so the mail that says calls are being refused goes
    // out on the first one rather than on whichever request happens to come
    // after it. It claims the month and swallows its own failures, so a mail
    // server that is down cannot turn into an error on a paid call — and the
    // claim is also what keeps a month at four fifths of its ceiling from being
    // mailed about once per request. See src/server/cap-warning.ts.
    await notifyCapWarning({
      tenantId,
      units: overage,
      cap,
      planKey: entitlements.planKey,
      appUrl: env().APP_URL,
    });

    if (!withinSpendCap(overage, cap)) {
      return Response.json(
        { error: "spend cap reached", capUnits: cap, ...usage },
        { status: 429 },
      );
    }
  }

  // Swap this for a real model call. Everything above is the part that has to
  // be right before a model call is worth making.
  return Response.json({
    reply: `(stub) you asked: ${parsed.data.prompt}`,
    planKey: entitlements.planKey,
    quota: usage,
    // What this month has run past the quota so far, which is what the next
    // invoice will carry. Zero while the allowance lasts, so a client can see
    // it start to cost before the bill says so.
    overage,
  });
});
