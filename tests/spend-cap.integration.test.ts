/**
 * The cap as it is stored, and the line below it a workspace asked to be warned
 * at: two nullable columns, where null is an answer in both.
 *
 * Against a real Postgres because the distinction that matters is the one the
 * database makes — a workspace that has never set a cap and one that set zero
 * are different rows, and reading the first as the second would stop an add-on
 * every customer from before caps existed is paying for.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { DEFAULT_CAP_WARNING_PCT, capWarningPct } from "@/domain/cap-warning";
import { UNCAPPED } from "@/domain/spend-cap";
import {
  capSettingsFor,
  setCapWarningAt,
  setSpendCap,
  spendCapFor,
} from "@/server/spend-cap";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("storing a spend cap", () => {
  let tenantId: string;

  beforeEach(async () => {
    await db.tenant.deleteMany();
    tenantId = (
      await db.tenant.create({ data: { email: `c${Date.now()}@example.test`, name: "Acme" } })
    ).id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("reads no cap for a workspace that has never set one", async () => {
    expect(await spendCapFor(tenantId)).toBe(UNCAPPED);
  });

  it("keeps a cap of zero apart from no cap at all", async () => {
    await setSpendCap(tenantId, 0);
    expect(await spendCapFor(tenantId)).toBe(0);

    await setSpendCap(tenantId, UNCAPPED);
    expect(await spendCapFor(tenantId)).toBe(UNCAPPED);
  });

  it("replaces the cap rather than accumulating caps", async () => {
    await setSpendCap(tenantId, 500);
    await setSpendCap(tenantId, 100);
    expect(await spendCapFor(tenantId)).toBe(100);
  });

  it("does not read another workspace's cap", async () => {
    const other = await db.tenant.create({
      data: { email: `o${Date.now()}@example.test`, name: "Other" },
    });
    await setSpendCap(other.id, 7);

    expect(await spendCapFor(tenantId)).toBe(UNCAPPED);
  });
});

describe.skipIf(!hasDatabase)("storing the line a cap warns at", () => {
  let tenantId: string;

  beforeEach(async () => {
    await db.tenant.deleteMany();
    tenantId = (
      await db.tenant.create({ data: { email: `w${Date.now()}@example.test`, name: "Acme" } })
    ).id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("reads no line for a workspace that has never picked one", async () => {
    const { warnAt } = await capSettingsFor(tenantId);
    expect(warnAt).toBeNull();
    // Null is the absence of an answer, not a line at nothing: the rule turns
    // it into the default rather than warning on the first unit past the quota.
    expect(capWarningPct(warnAt)).toBe(DEFAULT_CAP_WARNING_PCT);
  });

  it("keeps the lowest line apart from no line at all", async () => {
    await setCapWarningAt(tenantId, 1);
    expect((await capSettingsFor(tenantId)).warnAt).toBe(1);

    await setCapWarningAt(tenantId, null);
    expect((await capSettingsFor(tenantId)).warnAt).toBeNull();
  });

  it("replaces the line rather than accumulating lines", async () => {
    await setCapWarningAt(tenantId, 50);
    await setCapWarningAt(tenantId, 90);
    expect((await capSettingsFor(tenantId)).warnAt).toBe(90);
  });

  // The read the request in front of a billable call makes: one row answers
  // for both, so a call cannot be served against a ceiling the workspace set
  // and warned against a line it did not.
  it("answers with the ceiling and the line together", async () => {
    await setSpendCap(tenantId, 500);
    await setCapWarningAt(tenantId, 25);

    expect(await capSettingsFor(tenantId)).toEqual({ cap: 500, warnAt: 25 });
  });

  it("leaves the line alone when the cap moves, and the cap when the line does", async () => {
    // The two are set at different moments and neither save is a statement
    // about the other.
    await setSpendCap(tenantId, 500);
    await setCapWarningAt(tenantId, 25);

    await setSpendCap(tenantId, 900);
    expect(await capSettingsFor(tenantId)).toEqual({ cap: 900, warnAt: 25 });

    await setCapWarningAt(tenantId, 60);
    expect(await capSettingsFor(tenantId)).toEqual({ cap: 900, warnAt: 60 });
  });

  it("does not read another workspace's line", async () => {
    const other = await db.tenant.create({
      data: { email: `o${Date.now()}@example.test`, name: "Other" },
    });
    await setCapWarningAt(other.id, 30);

    expect(await capSettingsFor(tenantId)).toEqual({ cap: UNCAPPED, warnAt: null });
  });
});
