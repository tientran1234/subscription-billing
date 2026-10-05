/**
 * Where the overage job is run from: a machine credential posts here once the
 * month is over, and the workspace's usage past its quota is reported to the
 * provider.
 *
 * An API key rather than a session, because a scheduler is the caller this
 * exists for — and `billing:write` rather than a wildcard, so a key minted to
 * read the ledger cannot raise an invoice. The tenant is the key's own, the way
 * it is everywhere else here; a run across every workspace would need an
 * operator credential, and there are no roles yet (see the README).
 *
 * Posting twice bills nothing twice. That is the job's own guarantee, not this
 * route's: the month is claimed by primary key in src/server/usage-report.ts,
 * so a scheduler that fires late, twice, or after a crash is safe to point
 * here.
 */
import { z } from "zod";
import { isPeriod } from "@/domain/transactions";
import { billingProvider } from "@/providers";
import { reportOverage, type OverageFailure } from "@/server/usage-report";
import { withApiKey } from "@/server/with-api-key";

export const runtime = "nodejs";

// A month may be named, for the run that was missed; omitting it reports the
// one that has just closed, which is what a scheduler wants. `.strict()` so a
// caller sending a quantity of its own gets a 400 rather than having it
// ignored: what is owed is counted here from the meter, never accepted.
const Body = z
  .object({ period: z.string().refine(isPeriod, "period must be YYYY-MM").optional() })
  .strict();

const FAILURES: Record<OverageFailure, { status: number; error: string }> = {
  no_subscription: {
    status: 404,
    error: "this workspace has no subscription the gateway is billing",
  },
  // The request is well formed and the month simply is not over, the same shape
  // the seat floor is refused in: come back when it is.
  period_open: { status: 409, error: "that month has not closed yet" },
  // Nothing was billed and nothing was recorded as billed, so the next run
  // reports the month: the gateway is the part that failed, hence 502.
  report_failed: { status: 502, error: "the gateway refused the usage report" },
};

export const POST = withApiKey("billing:write", async (request, { tenantId }) => {
  // An empty body is the common call, so no JSON at all parses as no options.
  const parsed = Body.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await reportOverage(billingProvider(), {
    tenantId,
    period: parsed.data.period,
  });

  if (!result.ok) {
    const failure = FAILURES[result.reason];
    return Response.json(
      { error: failure.error, period: result.period },
      { status: failure.status },
    );
  }

  // 200 with the outcome, whatever it is: `duplicate` means the month had
  // already been reported and `no_overage` that there was nothing to report,
  // and both are the job working rather than failing.
  return Response.json({
    outcome: result.outcome,
    period: result.period,
    units: result.units,
  });
});
