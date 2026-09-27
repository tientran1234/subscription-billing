/**
 * Runs against a real Postgres: the claim being tested is that the WHERE clause
 * in src/server/transactions.ts draws the page boundary exactly where
 * `isOlderThanCursor` says it should. A mocked database would only prove the
 * mock agrees with itself.
 *
 *   pnpm db:up && pnpm db:push && pnpm test
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { usageFeatureFor } from "@/domain/api-key";
import { decodeCursor, isOlderThanCursor } from "@/domain/transactions";
import { authenticate, createApiKey, meterKey, revokeApiKey } from "@/server/api-keys";
import { listKeyUsage, listSubscriptions } from "@/server/transactions";
import { currentPeriod } from "@/server/usage";

const hasDatabase = Boolean(process.env.DATABASE_URL);

/** A minute apart, newest last, so the expected order is never in doubt. */
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 20, 12, minutes, 0, 0));

describe.skipIf(!hasDatabase)("transaction lists", () => {
  let tenantId: string;
  let otherTenantId: string;

  beforeEach(async () => {
    await db.tenant.deleteMany();
    const [mine, theirs] = await Promise.all([
      db.tenant.create({ data: { email: `a${Date.now()}@example.test`, name: "Acme" } }),
      db.tenant.create({ data: { email: `b${Date.now()}@example.test`, name: "Other" } }),
    ]);
    tenantId = mine.id;
    otherTenantId = theirs.id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const subscription = (over: Partial<{ planKey: string; status: string; createdAt: Date; tenantId: string }> = {}) =>
    db.subscription.create({
      data: { tenantId, planKey: "pro", status: "ACTIVE", ...over },
    });

  /** Walk the whole list a page at a time, the way the page's next link does. */
  const walk = async (limit: number) => {
    const seen: string[] = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const result = await listSubscriptions({ tenantId, cursor, limit });
      seen.push(...result.items.map((row) => row.planKey));
      if (!result.nextCursor) return seen;
      cursor = decodeCursor(result.nextCursor);
    }
    throw new Error("the list never ended — the cursor is not advancing");
  };

  describe("subscriptions", () => {
    it("serves every row exactly once, newest first, across pages", async () => {
      for (const [minute, planKey] of [[1, "one"], [2, "two"], [3, "three"], [4, "four"], [5, "five"]] as const) {
        await subscription({ createdAt: at(minute), planKey });
      }
      expect(await walk(2)).toEqual(["five", "four", "three", "two", "one"]);
    });

    it("neither repeats nor skips a row when newer ones land between pages", async () => {
      for (const [minute, planKey] of [[1, "one"], [2, "two"], [3, "three"], [4, "four"]] as const) {
        await subscription({ createdAt: at(minute), planKey });
      }

      const first = await listSubscriptions({ tenantId, limit: 2 });
      expect(first.items.map((row) => row.planKey)).toEqual(["four", "three"]);

      // Two checkouts start while the admin is reading page one. With OFFSET 2
      // the second page would come back as "four" and "three" again.
      await subscription({ createdAt: at(5), planKey: "five" });
      await subscription({ createdAt: at(6), planKey: "six" });

      const second = await listSubscriptions({
        tenantId,
        cursor: decodeCursor(first.nextCursor),
        limit: 2,
      });
      expect(second.items.map((row) => row.planKey)).toEqual(["two", "one"]);
      expect(second.nextCursor).toBeNull();
    });

    it("separates rows written in the very same millisecond", async () => {
      // Prisma stores millisecond precision, so this is a collision Postgres
      // really sees. On createdAt alone one of the two would be lost.
      const same = at(7);
      await subscription({ createdAt: same, planKey: "pro" });
      await subscription({ createdAt: same, planKey: "scale" });

      expect((await walk(1)).sort()).toEqual(["pro", "scale"]);
    });

    it("puts the page boundary where the domain rule says it is", async () => {
      for (const minute of [1, 2, 3, 4]) await subscription({ createdAt: at(minute) });

      const first = await listSubscriptions({ tenantId, limit: 2 });
      const cursor = decodeCursor(first.nextCursor);
      expect(cursor).not.toBeNull();

      const all = await db.subscription.findMany({ where: { tenantId } });
      const expected = all.filter((row) => isOlderThanCursor(row, cursor!)).map((row) => row.id);

      const second = await listSubscriptions({ tenantId, cursor, limit: 10 });
      expect(second.items.map((row) => row.id).sort()).toEqual(expected.sort());
    });

    it("narrows by status and by plan", async () => {
      await subscription({ createdAt: at(1), status: "PAST_DUE", planKey: "pro" });
      await subscription({ createdAt: at(2), status: "ACTIVE", planKey: "pro" });
      await subscription({ createdAt: at(3), status: "ACTIVE", planKey: "scale" });

      const pastDue = await listSubscriptions({ tenantId, filter: { status: "PAST_DUE" } });
      expect(pastDue.items.map((row) => row.planKey)).toEqual(["pro"]);

      const scale = await listSubscriptions({ tenantId, filter: { planKey: "scale" } });
      expect(scale.items.map((row) => row.status)).toEqual(["ACTIVE"]);
    });

    it("shows no other tenant's rows, not even paged into from their cursor", async () => {
      await subscription({ createdAt: at(1), planKey: "mine" });
      const theirs = await subscription({
        createdAt: at(9),
        planKey: "theirs",
        tenantId: otherTenantId,
      });

      const page = await listSubscriptions({ tenantId, cursor: theirs, limit: 10 });
      expect(page.items.map((row) => row.planKey)).toEqual(["mine"]);

      const unfiltered = await listSubscriptions({ tenantId, limit: 10 });
      expect(unfiltered.items).toHaveLength(1);
    });
  });

  describe("api key usage", () => {
    /** Mint a key and spend `calls` of its quota through the real meter. */
    const key = async (calls: number, createdAt?: Date) => {
      const { raw, key: created } = await createApiKey({
        tenantId,
        env: "test",
        scopes: ["assistant:use"],
      });
      if (createdAt) await db.apiKey.update({ where: { id: created.id }, data: { createdAt } });
      for (let call = 0; call < calls; call++) await meterKey(await authenticate(raw));
      return created.id;
    };

    it("reports what the meter actually counted for the key", async () => {
      const id = await key(3);
      const page = await listKeyUsage({ tenantId });
      expect(page.period).toBe(currentPeriod());
      expect(page.items.find((row) => row.id === id)?.used).toBe(3);
    });

    it("keeps a key nothing has called, at zero", async () => {
      // A counter row only exists once a call has been metered. Reading the
      // counters first and finding the key for each would drop this row.
      const id = await key(0);
      const page = await listKeyUsage({ tenantId });
      expect(page.items.map((row) => row.id)).toEqual([id]);
      expect(page.items[0].used).toBe(0);
    });

    it("counts one month at a time", async () => {
      await key(2);
      const lastMonth = await listKeyUsage({ tenantId, period: "2020-01" });
      expect(lastMonth.items[0].used).toBe(0);
    });

    it("attributes usage to the key that spent it", async () => {
      const quiet = await key(1, at(1));
      const busy = await key(4, at(2));

      const page = await listKeyUsage({ tenantId });
      const used = new Map(page.items.map((row) => [row.id, row.used]));
      expect(used.get(busy)).toBe(4);
      expect(used.get(quiet)).toBe(1);

      // The listing reads the bucket the meter filled, not one named like it.
      const counters = await db.usageCounter.findMany({ where: { tenantId } });
      expect(counters.map((c) => c.feature).sort()).toEqual(
        [usageFeatureFor(quiet), usageFeatureFor(busy)].sort(),
      );
    });

    it("narrows by state, and pages without repeating a key", async () => {
      const first = await key(0, at(1));
      const second = await key(0, at(2));
      const third = await key(0, at(3));
      await revokeApiKey(second, tenantId);

      const active = await listKeyUsage({ tenantId, state: "active" });
      expect(active.items.map((row) => row.id)).toEqual([third, first]);

      const revoked = await listKeyUsage({ tenantId, state: "revoked" });
      expect(revoked.items.map((row) => row.id)).toEqual([second]);

      const page = await listKeyUsage({ tenantId, limit: 2 });
      expect(page.items.map((row) => row.id)).toEqual([third, second]);
      const rest = await listKeyUsage({
        tenantId,
        cursor: decodeCursor(page.nextCursor),
        limit: 2,
      });
      expect(rest.items.map((row) => row.id)).toEqual([first]);
      expect(rest.nextCursor).toBeNull();
    });

    it("shows no other tenant's keys", async () => {
      await key(0);
      const page = await listKeyUsage({ tenantId: otherTenantId });
      expect(page.items).toEqual([]);
    });
  });
});
