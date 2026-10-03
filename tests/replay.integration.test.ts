/**
 * Runs against a real Postgres: a replay is only idempotent because a primary
 * key says so, and the audit is only a record because a row is written before
 * the work it describes. A mocked database would test the mock.
 *
 *   pnpm db:up && pnpm db:push && pnpm test
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type { BillingEvent } from "@/domain/billing-event";
import { FakeProvider } from "@/providers/fake";
import { applyEvent } from "@/server/billing.service";
import { replayEvent } from "@/server/replay";
import { MemoryMailer } from "@/server/mailer";

const hasDatabase = Boolean(process.env.DATABASE_URL);

const APP_URL = "https://billing.example.test";

/** Who asked. Held as plain columns, so no user row has to exist for it. */
const ASKED_BY = { userId: "usr_admin", userEmail: "admin@example.test" };

const event = (over: Partial<BillingEvent> & { providerEventId: string }): BillingEvent => ({
  type: "subscription_activated",
  checkoutRef: "cs_test_1",
  providerRef: "sub_1",
  ...over,
});

describe.skipIf(!hasDatabase)("webhook replay", () => {
  let tenantId: string;
  let subscriptionId: string;
  let provider: FakeProvider;

  /**
   * The gateway delivering an event — which is what gives it one to be asked
   * for again. Through `verifyWebhook` rather than by writing to the adapter's
   * map, so what a replay re-fetches is what a delivery carried.
   */
  const delivered = async (e: BillingEvent): Promise<BillingEvent> => {
    const body = JSON.stringify(e);
    await provider.verifyWebhook(body, provider.sign(body));
    return e;
  };

  const replay = (providerEventId: string, over: Partial<Parameters<typeof replayEvent>[1]> = {}) =>
    replayEvent(provider, { providerEventId, tenantId, ...ASKED_BY, appUrl: APP_URL, ...over });

  const audit = () =>
    db.eventReplay.findMany({ where: { tenantId }, orderBy: { requestedAt: "asc" } });

  beforeEach(async () => {
    await db.webhookEvent.deleteMany();
    await db.tenant.deleteMany();
    provider = new FakeProvider();

    const tenant = await db.tenant.create({
      data: { email: `t${Date.now()}@example.test`, name: "Acme" },
    });
    tenantId = tenant.id;

    const subscription = await db.subscription.create({
      data: { tenantId, planKey: "pro", status: "PENDING", checkoutRef: "cs_test_1" },
    });
    subscriptionId = subscription.id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const statusNow = async () =>
    (await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).status;

  it("applies a delivery that never arrived, and records who asked for it", async () => {
    await delivered(event({ providerEventId: "evt_missed" }));

    const result = await replay("evt_missed");

    expect(result).toMatchObject({ ok: true, outcome: "transitioned" });
    expect(await statusNow()).toBe("ACTIVE");
    expect(await audit()).toMatchObject([
      {
        providerEventId: "evt_missed",
        userId: "usr_admin",
        userEmail: "admin@example.test",
        outcome: "transitioned",
      },
    ]);
  });

  // The point of going back through applyEvent rather than around it: the event
  // id is claimed in WebhookEvent, so the second replay loses on the primary
  // key instead of activating the subscription again. Remove that and a replay
  // becomes a way to re-run a transition by hand.
  it("re-applies an event at most once, however often it is replayed", async () => {
    await delivered(event({ providerEventId: "evt_twice" }));

    expect(await replay("evt_twice")).toMatchObject({ outcome: "transitioned" });
    expect(await replay("evt_twice")).toMatchObject({ outcome: "duplicate" });

    expect(await statusNow()).toBe("ACTIVE");
    expect(await db.webhookEvent.count({ where: { providerEventId: "evt_twice" } })).toBe(1);
    // Two attempts, two rows: the audit is not keyed by the event id, because
    // "who replayed this, and how many times" is the question it is read for.
    expect(await audit()).toMatchObject([
      { providerEventId: "evt_twice", outcome: "transitioned" },
      { providerEventId: "evt_twice", outcome: "duplicate" },
    ]);
  });

  it("reports a delivery that was not missed after all as the duplicate it is", async () => {
    const missed = await delivered(event({ providerEventId: "evt_landed" }));
    expect(await applyEvent(provider.name, missed)).toBe("transitioned");

    expect(await replay("evt_landed")).toMatchObject({ ok: true, outcome: "duplicate" });
    expect(await statusNow()).toBe("ACTIVE");
  });

  // The guarantee the endpoint rests on. An event id names something at the
  // gateway, so without the ownership check a member of any workspace could
  // type another workspace's id and move its subscription — and the claim
  // happens after that check, so a refused replay does not even spend the
  // event id the real delivery still needs.
  it("refuses an event about another workspace, and applies nothing", async () => {
    await delivered(event({ providerEventId: "evt_theirs" }));

    const intruder = await db.tenant.create({
      data: { email: `intruder${Date.now()}@example.test`, name: "Intruder" },
    });
    const result = await replayEvent(provider, {
      providerEventId: "evt_theirs",
      tenantId: intruder.id,
      ...ASKED_BY,
      appUrl: APP_URL,
    });

    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(await statusNow()).toBe("PENDING");
    expect(await db.webhookEvent.count()).toBe(0);
    // Written against the workspace that asked, not the one that owns the
    // event: an attempt on somebody else's id is exactly what an audit is for.
    expect(
      await db.eventReplay.findMany({ where: { tenantId: intruder.id } }),
    ).toMatchObject([{ providerEventId: "evt_theirs", outcome: "forbidden" }]);
  });

  it("refuses an id the gateway has no event under", async () => {
    expect(await replay("evt_never_sent")).toEqual({ ok: false, reason: "no_event" });
    expect(await audit()).toMatchObject([{ outcome: "no_event" }]);
  });

  it("refuses an event that matches no subscription here", async () => {
    await delivered(
      event({ providerEventId: "evt_orphan", checkoutRef: "cs_other", providerRef: "sub_other" }),
    );

    expect(await replay("evt_orphan")).toEqual({ ok: false, reason: "not_found" });
    expect(await audit()).toMatchObject([{ outcome: "not_found" }]);
  });

  // The replay runs the webhook route's own sequence, so a missed failed
  // renewal still writes to the customer — they were never told the first
  // time. The DunningNotice claim is what keeps the second replay silent.
  it("writes to the customer about a status it moved, once", async () => {
    await db.subscription.update({ where: { id: subscriptionId }, data: { status: "ACTIVE" } });
    await delivered(event({ providerEventId: "evt_failed", type: "payment_failed" }));
    const mailer = new MemoryMailer();

    expect(await replay("evt_failed", { mailer })).toMatchObject({
      outcome: "transitioned",
      notified: "sent",
    });
    expect(await replay("evt_failed", { mailer })).toMatchObject({
      outcome: "duplicate",
      notified: "not_applicable",
    });

    expect(mailer.sent).toHaveLength(1);
    expect(await statusNow()).toBe("PAST_DUE");
  });

  // Why the audit row is written before the work rather than after it: an
  // attempt that dies halfway is the one worth finding, and an outcome nobody
  // recorded is how it reads.
  it("leaves the attempt on record when the replay itself fails", async () => {
    class BrokenGateway extends FakeProvider {
      async fetchEvent(): Promise<never> {
        throw new Error("the gateway timed out");
      }
    }
    provider = new BrokenGateway();

    await expect(replay("evt_lost")).rejects.toThrow(/timed out/);
    expect(await audit()).toMatchObject([{ providerEventId: "evt_lost", outcome: null }]);
  });
});
