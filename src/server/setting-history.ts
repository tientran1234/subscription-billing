/**
 * Writing down a setting a workspace has moved, and reading back the ones it
 * has moved lately.
 *
 * The write takes the client it is to use rather than reaching for `db`, so it
 * can go inside the transaction that moves the setting itself. That is the
 * whole reason this is a module and not a query at each of the three call
 * sites: a history written in a transaction of its own could disagree with the
 * column — a crash in between would leave a cap nobody set, or a row for a
 * change that never took — and the point of the table is to be the one place
 * that sequence survives.
 *
 * Like the role history and unlike the replay audit, the row goes in *after*
 * the work rather than before it. A replay is claimed early because an attempt
 * that dies halfway is itself worth finding; a setting that moved is not an
 * attempt. What is wanted here is that every value a workspace holds was
 * recorded as set by somebody, and the way to get that is to write the row in
 * the same transaction as the column, where neither can land without the other.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  SETTING_HISTORY_WINDOW,
  isSettingChange,
  type SettingValue,
  type TrackedSetting,
} from "@/domain/setting-history";

/**
 * Just the one model this needs, so a caller may hand it a transaction client
 * or the client itself without this file caring which it was given.
 */
export type SettingChangeWriter = Pick<Prisma.TransactionClient, "settingChange">;

/** Whoever is making the change, with the address as it reads right now. */
export interface SettingActor {
  userId: string;
  email: string;
}

export interface SettingChangeInput {
  tenantId: string;
  setting: TrackedSetting;
  /**
   * What the column held before this write, as the table holds it.
   *
   * Read inside the same transaction by each setter rather than passed down
   * from the route, so what is compared is what the column actually held and
   * not what a page rendered ten minutes ago. At read-committed two admins
   * saving the same setting in the same instant can both read the value in
   * front of them and both write a row; the column still ends on one of them,
   * and locking the tenant row to make that pair exact would slow every save
   * for a history nobody reads twice.
   */
  previous: SettingValue;
  value: SettingValue;
  /** Who changed it. Never defaulted: an unattributed change is the one row
   *  this table exists to not have. */
  changedBy: SettingActor;
}

/**
 * Record `input` as a change, if it is one, and say whether it was.
 *
 * The decision is `isSettingChange`'s rather than this file's, so the three
 * settings cannot come to different conclusions about what is worth recording.
 */
export async function recordSettingChange(
  writer: SettingChangeWriter,
  input: SettingChangeInput,
): Promise<boolean> {
  if (!isSettingChange(input.previous, input.value)) return false;

  await writer.settingChange.create({
    data: {
      tenantId: input.tenantId,
      setting: input.setting,
      value: input.value,
      changedByUserId: input.changedBy.userId,
      changedByEmail: input.changedBy.email,
    },
  });
  return true;
}

/** One change, as the transactions page lists it. */
export interface SettingChangeView {
  id: string;
  /**
   * The name as it was written, not narrowed to a `TrackedSetting`.
   *
   * This table outlives the build that wrote it, and a row naming a setting
   * this one has never heard of is still something the workspace did: dropping
   * it would be a gap in an audit, and reading it as one of ours would put a
   * change under the wrong heading. The page draws a label for the names it
   * knows and the name itself for the rest — `isTrackedSetting` is that guard.
   */
  setting: string;
  value: SettingValue;
  /** The address as it was at the time, which is what was recorded. */
  changedByEmail: string;
  changedAt: Date;
}

/**
 * The settings this workspace has moved, newest first.
 *
 * Scoped to the tenant in SQL like every other list on that page. No cursor
 * behind it: `SETTING_HISTORY_WINDOW` says why the last few are the answer, and
 * a second paginated list would be a position to carry in the URL for the sake
 * of a question nobody asks twice.
 */
export async function settingHistoryOf(
  tenantId: string,
  limit = SETTING_HISTORY_WINDOW,
): Promise<SettingChangeView[]> {
  const rows = await db.settingChange.findMany({
    where: { tenantId },
    orderBy: { changedAt: "desc" },
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    setting: row.setting,
    value: row.value,
    changedByEmail: row.changedByEmail,
    changedAt: row.changedAt,
  }));
}
