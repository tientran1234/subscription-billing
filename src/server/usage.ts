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
