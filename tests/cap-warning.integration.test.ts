/**
 * Runs against a real Postgres: "this workspace is told once a month" is a
 * unique index, the same way "this event is applied once" is. The guarantee
 * being proved here is the one a mocked database cannot hold — a counter that
 * has crossed a line stays crossed for every call after it, so the claim is the
 * only thing standing between one warning and one per request for the rest of
 * the month.
 *
 *   pnpm db:up && pnpm db:push && pnpm test
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { UNCAPPED } from "@/domain/spend-cap";
import { notifyCapWarning } from "@/server/cap-warning";
import { MemoryMailer, type Mailer } from "@/server/mailer";

const hasDatabase = Boolean(process.env.DATABASE_URL);

const APP_URL = "https://billing.example.test";

const PERIOD = "2026-10";

/** Nothing this one is handed ever reaches a mailbox. */
class BrokenMailer implements Mailer {
  async send(): Promise<void> {
    throw new Error("smtp refused the connection");
  }
}

describe.skipIf(!hasDatabase)("spend cap warnings", () => {
  let tenantId: string;
  let mailer: MemoryMailer;

  /** The assistant route's own call: the units it metered against the cap it read. */
  const warn = (units: number, cap: number | null, using?: Mailer) =>
    notifyCapWarning({
      tenantId,
      units,
      cap,
      planKey: "pro",
      appUrl: APP_URL,
      period: PERIOD,
      mailer: using ?? mailer,
    });

  beforeEach(async () => {
    await db.tenant.deleteMany();
    mailer = new MemoryMailer();

    tenantId = (
      await db.tenant.create({ data: { email: `t${Date.now()}@example.test`, name: "Acme" } })
    ).id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("writes to the workspace as its ceiling comes up", async () => {
    expect(await warn(400, 500)).toBe("sent");

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toBe("You are close to your spend cap");
    expect(mailer.sent[0].html).toContain(`${APP_URL}/en/account`);
    expect(mailer.sent[0].to).toBe((await db.tenant.findUnique({ where: { id: tenantId } }))!.email);
  });

  it("writes again, once, when the ceiling actually refuses a call", async () => {
    // Two different pieces of news in one month: the second is the one the
    // customer's key has just started failing on.
    expect(await warn(400, 500)).toBe("sent");
    expect(await warn(501, 500)).toBe("sent");

    expect(mailer.sent.map((m) => m.subject)).toEqual([
      "You are close to your spend cap",
      "Your spend cap has paused further usage",
    ]);
  });

  // The guarantee. Without the claim, a workspace sitting above the line would
  // be mailed on every request it makes for the rest of the month.
  it("writes once however many calls come through past the same line", async () => {
    expect(await warn(400, 500)).toBe("sent");

    for (const units of [401, 420, 499, 500]) {
      expect(await warn(units, 500)).toBe("duplicate");
    }

    expect(mailer.sent).toHaveLength(1);
  });

  it("lets only one of two concurrent calls past the same line through", async () => {
    const outcomes = await Promise.all([warn(400, 500), warn(401, 500)]);

    expect(outcomes.filter((o) => o === "sent")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("says it again next month, because the allowance has reset", async () => {
    expect(await warn(400, 500)).toBe("sent");

    const next = await notifyCapWarning({
      tenantId,
      units: 400,
      cap: 500,
      planKey: "pro",
      appUrl: APP_URL,
      period: "2026-11",
      mailer,
    });

    expect(next).toBe("sent");
    expect(mailer.sent).toHaveLength(2);
  });

  it("releases the claim when the mailer refuses it, so a later call retries", async () => {
    // A row means a mail went out. None did, and one left behind would silence
    // the rest of the month.
    expect(await warn(400, 500, new BrokenMailer())).toBe("send_failed");
    expect(await db.capNotice.count()).toBe(0);

    expect(await warn(410, 500)).toBe("sent");
    expect(mailer.sent).toHaveLength(1);
  });

  it("stays quiet, and claims nothing, for a workspace with no ceiling", async () => {
    expect(await warn(1_000_000, UNCAPPED)).toBe("not_applicable");

    expect(mailer.sent).toHaveLength(0);
    expect(await db.capNotice.count()).toBe(0);
  });

  it("stays quiet while the month is well inside its ceiling", async () => {
    expect(await warn(100, 500)).toBe("not_applicable");
    expect(mailer.sent).toHaveLength(0);
  });

  it("records the figures as they were, not as the cap was later moved to", async () => {
    await warn(400, 500);

    const notice = await db.capNotice.findFirst({ where: { tenantId } });
    expect(notice).toMatchObject({ period: PERIOD, kind: "approaching", units: 400, cap: 500 });
  });

  it("warns a workspace in the language it recorded", async () => {
    // The end of the wire the unit tests cannot reach: the column on the
    // tenant is what this sender reads too, and the link goes with it.
    await db.tenant.update({ where: { id: tenantId }, data: { locale: "vi" } });

    expect(await warn(400, 500)).toBe("sent");

    const mail = mailer.sent[0];
    expect(mail.subject).toBe("Bạn đã gần đạt giới hạn chi tiêu");
    expect(mail.html).toContain(`${APP_URL}/vi/account`);
  });

  it("does not write to a workspace that is not there", async () => {
    await db.tenant.delete({ where: { id: tenantId } });

    expect(await warn(400, 500)).toBe("not_found");
    expect(mailer.sent).toHaveLength(0);
  });
});
