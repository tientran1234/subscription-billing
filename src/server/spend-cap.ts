/**
 * Reading and writing the ceiling a workspace set on its metered add-on, and
 * the line below it they asked to be warned at.
 *
 * A few lines of Prisma, kept behind names rather than inlined, because the cap
 * is read by the route that refuses a call and by the job that bills the month,
 * and both have to get the same answer for a column nobody has written yet: a
 * null is `UNCAPPED`, not a zero, and an unset line is the default, not a line
 * at nothing.
 */
import { db } from "@/lib/db";
import { UNCAPPED, type SpendCap } from "@/domain/spend-cap";
import type { CapWarningAt } from "@/domain/cap-warning";

/** A workspace's ceiling and the line below it, as one row answers for both. */
export interface CapSettings {
  cap: SpendCap;
  /** Null for a workspace that never picked one; see src/domain/cap-warning.ts. */
  warnAt: CapWarningAt;
}

export async function spendCapFor(tenantId: string): Promise<SpendCap> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { overageCap: true },
  });
  // A tenant that is not there answers the same as one that set nothing. The
  // callers have already proved the tenant is theirs, so this is the row having
  // been deleted underneath a request rather than a question about access.
  return tenant?.overageCap ?? UNCAPPED;
}

export async function setSpendCap(tenantId: string, cap: SpendCap): Promise<void> {
  await db.tenant.update({ where: { id: tenantId }, data: { overageCap: cap } });
}

/**
 * Both settings in one read, for the callers that need both.
 *
 * One query rather than two because the request that wants them is the one in
 * front of a billable call: it reads the ceiling to decide whether to serve it
 * and the line to decide whether to write about it, and the two are columns of
 * the same row. It is also what keeps the rule in src/domain/cap-warning.ts
 * pure — a line passed in is a line that costs the requests nowhere near it
 * nothing, where reading it inside the notice would put a query on every call
 * past the quota.
 */
export async function capSettingsFor(tenantId: string): Promise<CapSettings> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { overageCap: true, capWarnPct: true },
  });
  return { cap: tenant?.overageCap ?? UNCAPPED, warnAt: tenant?.capWarnPct ?? null };
}

export async function setCapWarningAt(tenantId: string, at: CapWarningAt): Promise<void> {
  await db.tenant.update({ where: { id: tenantId }, data: { capWarnPct: at } });
}
