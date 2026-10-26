/**
 * Reading and writing the ceiling a workspace set on its metered add-on, and
 * the line below it they asked to be warned at.
 *
 * A few lines of Prisma, kept behind names rather than inlined, because the cap
 * is read by the route that refuses a call and by the job that bills the month,
 * and both have to get the same answer for a column nobody has written yet: a
 * null is `UNCAPPED`, not a zero, and an unset line is the default, not a line
 * at nothing.
 *
 * Both writes take the account making them and move the column inside a
 * transaction that records the move — see src/server/setting-history.ts for why
 * the row and the column land together or not at all. There is deliberately no
 * way to set either figure without saying who did: a cap that moved with nobody
 * attached is the row the history exists to not have.
 */
import { db } from "@/lib/db";
import { UNCAPPED, type SpendCap } from "@/domain/spend-cap";
import type { CapWarningAt } from "@/domain/cap-warning";
import { settingValueOf } from "@/domain/setting-history";
import { recordSettingChange, type SettingActor } from "./setting-history";

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

export async function setSpendCap(
  tenantId: string,
  cap: SpendCap,
  by: SettingActor,
): Promise<void> {
  await db.$transaction(async (tx) => {
    // Read before the update, because Prisma hands back the row as it is after
    // one and the history needs to know whether anything moved. Inside the
    // transaction rather than from the caller, so what is compared is the
    // column rather than whatever a page was rendered with.
    const before = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { overageCap: true },
    });
    await tx.tenant.update({ where: { id: tenantId }, data: { overageCap: cap } });
    await recordSettingChange(tx, {
      tenantId,
      setting: "spend_cap",
      previous: settingValueOf(before?.overageCap ?? UNCAPPED),
      value: settingValueOf(cap),
      changedBy: by,
    });
  });
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

export async function setCapWarningAt(
  tenantId: string,
  at: CapWarningAt,
  by: SettingActor,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const before = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { capWarnPct: true },
    });
    await tx.tenant.update({ where: { id: tenantId }, data: { capWarnPct: at } });
    await recordSettingChange(tx, {
      tenantId,
      setting: "cap_warning_pct",
      previous: settingValueOf(before?.capWarnPct ?? null),
      value: settingValueOf(at),
      changedBy: by,
    });
  });
}
