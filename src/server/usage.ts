import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/** UTC month bucket, e.g. "2026-09" — the quota period. */
export function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export interface MeterResult {
  used: number;
  limit: number;
  allowed: boolean;
}

/**
 * Count one unit of usage and say whether it was within quota.
 *
 * The counter is incremented in the database, not read-then-written in Node, so
 * concurrent requests cannot both read 49 and both write 50. Two requests
 * racing to create the very first row of a period is the one case Postgres
 * settles with a unique-violation, which we retry as a plain increment.
 */
export async function meter(
  tenantId: string,
  feature: string,
  limit: number,
  n = 1,
  now = new Date(),
): Promise<MeterResult> {
  const period = currentPeriod(now);
  const key = { tenantId_feature_period: { tenantId, feature, period } };

  let used: number;
  try {
    const row = await db.usageCounter.upsert({
      where: key,
      create: { tenantId, feature, period, used: n },
      update: { used: { increment: n } },
    });
    used = row.used;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const row = await db.usageCounter.update({
        where: key,
        data: { used: { increment: n } },
      });
      used = row.used;
    } else {
      throw err;
    }
  }

  return { used, limit, allowed: used <= limit };
}

/**
 * Give back a unit counted for a call that produced nothing.
 *
 * Counting first and giving back is the awkward way round, and it is the only
 * way round that works: the quota and the spend cap are decided from the
 * counter, so a call metered after the fact is a call that was let through on
 * a figure taken before it — and two of those racing both pass a ceiling only
 * one of them was inside.
 *
 * Conditional on the row holding the units, so the decrement is an
 * affected-row count rather than a read and a write: a period with nothing in
 * it, or one already given back, loses the `where` instead of counting
 * backwards past zero. A counter the overage job reads is a figure on an
 * invoice, and a negative one would discount the month.
 */
export async function refund(
  tenantId: string,
  feature: string,
  n = 1,
  now = new Date(),
): Promise<boolean> {
  const { count } = await db.usageCounter.updateMany({
    where: { tenantId, feature, period: currentPeriod(now), used: { gte: n } },
    data: { used: { decrement: n } },
  });
  return count === 1;
}
