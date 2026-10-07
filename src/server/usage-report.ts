/**
 * Reporting a month of overage to the provider: count what was used past the
 * quota, claim the month, tell the gateway.
 *
 * The job is durable in the one way that matters for money — it can be run
 * again. Whatever runs it (a scheduler, a retry after a crash, somebody by
 * hand) may run it at least once and more than once, so the guarantee is a
 * primary key rather than a promise about who calls when: `UsageReport` is
 * keyed by (subscription, period), and a second run loses the insert instead of
 * billing the month twice. Idempotency per period is also why the month has to
 * have closed — see src/domain/overage.ts, which refuses one still accruing.
 *
 * The claim is written BEFORE the report and released if the gateway refuses
 * it, exactly as a dunning notice is: a row here means the provider was told,
 * and one left behind after a failed call would both lie and block the next
 * run. The figure it carries cannot drift either, because a closed month's
 * counter never moves again.
 *
 * It reports the tenant's newest subscription and no other. A usage counter
 * belongs to the workspace rather than to one of its subscription rows, so a
 * workspace that cancelled and subscribed again would otherwise have the same
 * month billed once per row — and the newest is the row every other derived
 * answer here is read off.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { IBillingProvider } from "@/domain/billing-event";
import { entitlementsFor, quotaFor } from "@/domain/entitlements";
import { OVERAGE_QUOTA, checkOverage } from "@/domain/overage";
import { shiftPeriod } from "@/domain/transactions";
import { spendCapFor } from "./spend-cap";
import { currentPeriod } from "./usage";

export interface ReportOverageInput {
  /** The tenant the caller proved they may act for — never read off the body. */
  tenantId: string;
  /** Which month to report. Omitted means the one that has just closed. */
  period?: string;
  now?: Date;
}

export type OverageOutcome =
  /** The units were reported and the month claimed. */
  | "reported"
  /** This month had already been reported — nothing was sent. */
  | "duplicate"
  /** The month stayed inside the quota, so there is nothing to bill. */
  | "no_overage"
  /** The workspace's own ceiling is zero: the usage happened and was refused. */
  | "capped"
  /** This subscription's quota is a ceiling: the calls were refused, not billed. */
  | "not_metered";

export type OverageFailure =
  /** No subscription the provider is billing, so nowhere to report usage. */
  | "no_subscription"
  /** That month has not finished; its figure is not final yet. */
  | "period_open"
  /** The provider refused the report. The claim was released, so a later run can retry. */
  | "report_failed";

export type ReportOverageResult =
  | { ok: true; outcome: OverageOutcome; period: string; units: number }
  | { ok: false; reason: OverageFailure; period: string };

export async function reportOverage(
  provider: IBillingProvider,
  input: ReportOverageInput,
): Promise<ReportOverageResult> {
  const now = input.now ?? new Date();
  const period = input.period ?? shiftPeriod(currentPeriod(now), -1);

  const subscription = await db.subscription.findFirst({
    where: { tenantId: input.tenantId },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription?.providerRef) return { ok: false, reason: "no_subscription", period };

  // Derived, not read off the row: whether the quota is a threshold is the same
  // question the assistant route asks before letting a call past it, and asking
  // it twice in two ways is how a workspace comes to be billed for usage it was
  // refused — or refused usage it is being billed for.
  const entitlements = entitlementsFor(
    subscription.planKey,
    subscription.status,
    subscription.seats,
    subscription.meteredOverage,
  );

  const counter = await db.usageCounter.findUnique({
    where: {
      tenantId_feature_period: {
        tenantId: input.tenantId,
        feature: OVERAGE_QUOTA,
        period,
      },
    },
  });

  const check = checkOverage({
    meteredOverage: entitlements.meteredOverage,
    // No counter row means the feature was never called in that month.
    used: counter?.used ?? 0,
    limit: quotaFor(entitlements, OVERAGE_QUOTA),
    // The clamp that decides the invoice. The assistant route refuses calls once
    // the cap is reached, but it refuses them AFTER `meter` has counted them —
    // and a race, a cap lowered mid-month, or usage metered by anything else
    // leaves a counter above the ceiling all the same. Billing `used - limit`
    // here would charge for the units the cap exists to prevent, so the figure
    // this job reports is the capped one.
    cap: await spendCapFor(input.tenantId),
    period,
    currentPeriod: currentPeriod(now),
  });
  if (!check.ok) {
    // A month still running is the one refusal a caller got wrong rather than
    // an answer about the month: nothing is claimed, and it is worth asking
    // again once the month is over.
    if (check.reason === "period_open") {
      return { ok: false, reason: "period_open", period };
    }
    return { ok: true, outcome: check.reason, period, units: 0 };
  }

  // The claim IS the lock, as it is in applyEvent and in a dunning notice: a
  // second run loses on the primary key rather than on a read of whether this
  // month has been reported, which is a window two runs can both come through.
  try {
    await db.usageReport.create({
      data: { subscriptionId: subscription.id, period, quantity: check.units },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // The figure is the same one the first run reported — a closed month's
      // counter cannot have moved since — so there is nothing to reconcile.
      return { ok: true, outcome: "duplicate", period, units: check.units };
    }
    throw err;
  }

  try {
    await provider.reportUsage({
      providerRef: subscription.providerRef,
      quantity: check.units,
      period,
    });
  } catch {
    // Release it. A row here means the gateway was told; one standing after a
    // refused call would keep every later run from telling it.
    await db.usageReport.delete({
      where: { subscriptionId_period: { subscriptionId: subscription.id, period } },
    });
    return { ok: false, reason: "report_failed", period };
  }

  return { ok: true, outcome: "reported", period, units: check.units };
}
