/**
 * What a workspace can say about the settings it has moved: which one, what it
 * became, who changed it and when.
 *
 * Pure — no I/O — like the rest of this directory, so the one rule that decides
 * whether a write is worth recording is written here instead of beside each of
 * the three columns that have one.
 *
 * The settings recorded are the ones a workspace sets on itself: the ceiling on
 * its metered add-on, the line below it a warning goes out at, and the language
 * it is written to in. Each is a column that overwrites the one before it, so
 * this table is the only place the sequence of those writes survives — the same
 * reason roles have one. The plan is deliberately not among them: it moves on
 * the gateway's paid invoice rather than on a form here, and what it used to be
 * is readable on the invoices that billed it.
 *
 * Kept apart from the modules that own the settings, and for the reason
 * `role-history.ts` is kept out of `role.ts`: nothing here guards anything. A
 * cap read out of the past rather than off the column would be a second answer
 * to what a workspace is willing to be billed, and the one that goes stale the
 * first time a row is missing.
 */

/**
 * The settings whose moves are recorded, as the `setting` column spells them.
 *
 * Snake-cased strings of their own rather than the column names they shadow:
 * what a reader of this table wants is which setting moved, which outlives the
 * day one of those columns is renamed or moved off the tenant.
 */
export const TRACKED_SETTINGS = ["spend_cap", "cap_warning_pct", "notice_locale"] as const;

export type TrackedSetting = (typeof TRACKED_SETTINGS)[number];

/**
 * Whether `raw` is a setting this build knows the name of.
 *
 * A guard rather than a narrowing fallback like `roleFrom`'s, because there is
 * no setting a name this build does not recognise could safely read as. An
 * audit row is never dropped for failing it — see the page, which shows the
 * name as it was written — it just has no label of ours to be drawn under.
 */
export function isTrackedSetting(raw: string): raw is TrackedSetting {
  return (TRACKED_SETTINGS as readonly string[]).includes(raw);
}

/**
 * How many changes the workspace is shown, newest first.
 *
 * A window and not a page back through them, for the reason the role history
 * keeps twenty: what this is read for is the last few moves — who raised the
 * ceiling, and when — and a workspace that has moved its settings more often
 * than this has a table to query rather than a question the page can answer.
 */
export const SETTING_HISTORY_WINDOW = 20;

/**
 * A setting's value as the table holds it: text, or null for one that is not
 * set.
 *
 * Text for all three, rather than a column per shape, because the value here is
 * only ever read back to be shown. What decides anything is the live column —
 * that is the whole of the note above — so a figure kept as text costs nothing,
 * where an integer column beside a string one would be two mostly-null columns
 * and a third the day a setting of some other shape is added.
 *
 * Null is a value, not a missing one, exactly as it is on the columns this
 * shadows: an unset cap is uncapped and an unset line is the default, and a
 * workspace clearing either has said something worth a row.
 */
export type SettingValue = string | null;

/** A setting's value, as the table holds it. */
export function settingValueOf(value: number | string | null): SettingValue {
  return value === null ? null : String(value);
}

/**
 * Whether writing `value` over `previous` moved the setting.
 *
 * A write that leaves a setting as it was is not a change. The account page
 * posts whatever is in the box, so a reader who opens it and saves without
 * touching anything sends the figure that is already stored — this path is
 * handed no-ops in the ordinary course of things. Recording them would not just
 * pad the history: it would make the date beside a figure the date it was last
 * confirmed instead of the date it was set, which is the one thing the history
 * is read for.
 */
export function isSettingChange(previous: SettingValue, value: SettingValue): boolean {
  return previous !== value;
}
