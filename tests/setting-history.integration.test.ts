/**
 * Runs against a real Postgres, because what is being tested is what survives
 * in the table: a change written in the same transaction as the column it
 * describes, a no-op that leaves no row behind, and a row that is still legible
 * when it names a setting this build has never heard of. Mocking the database
 * would test the mock.
 *
 *   pnpm db:up && pnpm db:push && pnpm test
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { SETTING_HISTORY_WINDOW } from "@/domain/setting-history";
import { UNCAPPED } from "@/domain/spend-cap";
import { recordSettingChange, settingHistoryOf } from "@/server/setting-history";
import { setCapWarningAt, setSpendCap } from "@/server/spend-cap";
import { setTenantLocale } from "@/server/tenant-locale";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("the settings a workspace has moved", () => {
  let tenantId: string;
  let adminEmail: string;

  const by = () => ({ userId: "u_admin", email: adminEmail });

  beforeEach(async () => {
    await db.tenant.deleteMany();

    adminEmail = `admin-${randomUUID()}@example.test`;
    const tenant = await db.tenant.create({ data: { email: adminEmail, name: "Acme" } });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("records the ceiling a workspace set, and who set it", async () => {
    await setSpendCap(tenantId, 500, by());

    expect(await settingHistoryOf(tenantId)).toEqual([
      {
        id: expect.any(String),
        setting: "spend_cap",
        value: "500",
        changedByEmail: adminEmail,
        changedAt: expect.any(Date),
      },
    ]);
  });

  it("records the warning line and the notice language under their own names", async () => {
    await setCapWarningAt(tenantId, 60, by());
    await setTenantLocale(tenantId, "vi", by());

    expect((await settingHistoryOf(tenantId)).map((row) => [row.setting, row.value])).toEqual([
      ["notice_locale", "vi"],
      ["cap_warning_pct", "60"],
    ]);
  });

  it("records a ceiling lifted, because an uncapped workspace chose that", async () => {
    await setSpendCap(tenantId, 500, by());
    await setSpendCap(tenantId, UNCAPPED, by());

    // Null is the value, not a row that failed to say one: the history has to
    // be able to answer who took the ceiling off.
    expect((await settingHistoryOf(tenantId)).map((row) => row.value)).toEqual([null, "500"]);
  });

  it("leaves no row for a save that changed nothing", async () => {
    await setSpendCap(tenantId, 500, by());
    await setSpendCap(tenantId, 500, by());
    await setCapWarningAt(tenantId, null, by());

    // The second save is what the account page sends when a reader opens it and
    // presses save, and the line was never set, so putting it back to the
    // default moved nothing either. One row, and its date is the date the
    // ceiling was set rather than the date it was last confirmed.
    const history = await settingHistoryOf(tenantId);
    expect(history).toHaveLength(1);
    expect(history[0].value).toBe("500");
  });

  it("writes the row and the column together or not at all", async () => {
    // The update fails, so there is no change to record. A history written in
    // a transaction of its own would leave a row here for a ceiling that was
    // never set on anybody.
    await expect(setSpendCap(`missing-${randomUUID()}`, 500, by())).rejects.toThrow();
    expect(await db.settingChange.count()).toBe(0);
  });

  it("lists newest first, within the window", async () => {
    for (let cap = 1; cap <= SETTING_HISTORY_WINDOW + 3; cap += 1) {
      await setSpendCap(tenantId, cap, by());
    }

    const history = await settingHistoryOf(tenantId);
    expect(history).toHaveLength(SETTING_HISTORY_WINDOW);
    expect(history[0].value).toBe(String(SETTING_HISTORY_WINDOW + 3));
    for (const [i, row] of history.entries()) {
      if (i > 0) {
        expect(row.changedAt.getTime()).toBeLessThanOrEqual(history[i - 1].changedAt.getTime());
      }
    }
  });

  it("does not list another workspace's changes", async () => {
    const other = await db.tenant.create({
      data: { email: `other-${randomUUID()}@example.test`, name: "Other" },
    });
    await setSpendCap(other.id, 7, by());
    await setSpendCap(tenantId, 500, by());

    expect((await settingHistoryOf(tenantId)).map((row) => row.value)).toEqual(["500"]);
    expect((await settingHistoryOf(other.id)).map((row) => row.value)).toEqual(["7"]);
  });

  it("hands back a setting name it does not recognise rather than dropping the row", async () => {
    // A row this build never wrote, which is what the table looks like after a
    // setting is added and the page is rolled back. The audit is still the
    // audit: the page draws the name as it was written.
    await recordSettingChange(db, {
      tenantId,
      // Deliberately outside `TrackedSetting` — the cast is the point of the
      // test, and the reason the view keeps the column as a string.
      setting: "something_later" as "spend_cap",
      previous: null,
      value: "7",
      changedBy: by(),
    });

    expect((await settingHistoryOf(tenantId)).map((row) => row.setting)).toEqual([
      "something_later",
    ]);
  });

  it("keeps a change after the account that made it is gone", async () => {
    // Plain columns rather than a relation: an audit row has to outlive the
    // account it names, and there is no user row for this one at all.
    await setSpendCap(tenantId, 500, by());

    expect((await settingHistoryOf(tenantId))[0].changedByEmail).toBe(adminEmail);
    expect(await db.user.count({ where: { email: adminEmail } })).toBe(0);
  });
});
