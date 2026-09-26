/**
 * Runs against a real Postgres: "this customer is emailed once" is a unique
 * index, the same way "this event is applied once" is. A mocked database
 * would only prove the mock refuses a second insert.
 *
 *   pnpm db:up && pnpm db:push && pnpm test
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { applyEvent } from "@/server/billing.service";
import { notifyDunning } from "@/server/dunning";
import { MemoryMailer, type Mailer, type OutboundEmail } from "@/server/mailer";
import type { BillingEvent } from "@/domain/billing-event";

const hasDatabase = Boolean(process.env.DATABASE_URL);

const APP_URL = "https://billing.example.test";

const event = (over: Partial<BillingEvent> & { providerEventId: string }): BillingEvent => ({
  type: "subscription_activated",
  providerRef: "sub_1",
  ...over,
});

/** Nothing this one is handed ever reaches a mailbox. */
class BrokenMailer implements Mailer {
  async send(): Promise<void> {
    throw new Error("smtp refused the connection");
  }
}

describe.skipIf(!hasDatabase)("dunning notices", () => {
  let tenantId: string;
  let mailer: MemoryMailer;

  /** The webhook route's own sequence: apply the event, then write about it. */
  const deliver = async (e: BillingEvent, using: Mailer = mailer) => {
    const outcome = await applyEvent("stripe", e);
    return notifyDunning({ event: e, outcome, appUrl: APP_URL, mailer: using });
  };

  beforeEach(async () => {
    await db.webhookEvent.deleteMany();
    await db.tenant.deleteMany();
    mailer = new MemoryMailer();

    const tenant = await db.tenant.create({
      data: { email: `t${Date.now()}@example.test`, name: "Acme" },
    });
    tenantId = tenant.id;

    await db.subscription.create({
      data: { tenantId, planKey: "pro", status: "ACTIVE", providerRef: "sub_1" },
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const only = (sent: readonly OutboundEmail[]): OutboundEmail => {
    expect(sent).toHaveLength(1);
    return sent[0];
  };

  it("writes to the customer when a renewal fails", async () => {
    const outcome = await deliver(event({ providerEventId: "evt_1", type: "payment_failed" }));

    expect(outcome).toBe("sent");
    const mail = only(mailer.sent);
    expect(mail.subject).toBe("We could not take your payment");
    expect(mail.html).toContain(`${APP_URL}/en/account`);
    // The plan they are still on, not the plan they will fall back to.
    expect(mail.html).toContain("Pro");
  });

  it("says goodbye when the subscription ends", async () => {
    const outcome = await deliver(
      event({ providerEventId: "evt_1", type: "subscription_canceled" }),
    );

    expect(outcome).toBe("sent");
    expect(only(mailer.sent).subject).toBe("Your subscription has ended");
  });

  it("does not write the same customer twice for a redelivered event", async () => {
    const e = event({ providerEventId: "evt_1", type: "payment_failed" });

    expect(await deliver(e)).toBe("sent");
    expect(await deliver(e)).toBe("not_applicable"); // applyEvent already said duplicate
    expect(mailer.sent).toHaveLength(1);
  });

  it("sends once even when the same event id is notified twice directly", async () => {
    // Bypasses applyEvent's own claim on purpose: the guarantee has to hold
    // for a manual replay or a backfill, not only for the one caller that
    // happens to run first today.
    const e = event({ providerEventId: "evt_1", type: "payment_failed" });
    const notify = () =>
      notifyDunning({ event: e, outcome: "transitioned", appUrl: APP_URL, mailer });

    expect(await notify()).toBe("sent");
    expect(await notify()).toBe("duplicate");
    expect(mailer.sent).toHaveLength(1);
  });

  it("lets only one of two concurrent notices for one event id through", async () => {
    const e = event({ providerEventId: "evt_1", type: "subscription_canceled" });
    const notify = () =>
      notifyDunning({ event: e, outcome: "transitioned", appUrl: APP_URL, mailer });

    const outcomes = await Promise.all([notify(), notify()]);

    expect(outcomes.filter((o) => o === "sent")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("stays quiet about a status that did not move", async () => {
    // A cancellation that lost the conditional UPDATE changed nothing, so
    // there is nothing to tell the customer about.
    await deliver(event({ providerEventId: "evt_1", type: "subscription_canceled" }));
    const late = await deliver(
      event({ providerEventId: "evt_2", type: "subscription_canceled" }),
    );

    expect(late).toBe("not_applicable");
    expect(mailer.sent).toHaveLength(1);
  });

  it("stays quiet about good news", async () => {
    await db.subscription.updateMany({ where: { tenantId }, data: { status: "PAST_DUE" } });

    const outcome = await deliver(event({ providerEventId: "evt_1" }));

    expect(outcome).toBe("not_applicable");
    expect(mailer.sent).toHaveLength(0);
  });

  it("writes to the tenant the subscription belongs to", async () => {
    const other = await db.tenant.create({
      data: { email: `other${Date.now()}@example.test`, name: "Other" },
    });
    await db.subscription.create({
      data: { tenantId: other.id, planKey: "scale", status: "ACTIVE", providerRef: "sub_2" },
    });

    await deliver(event({ providerEventId: "evt_1", type: "payment_failed" }));

    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(only(mailer.sent).to).toBe(tenant.email);
  });

  it("leaves no record of a mail the server refused, so a replay can still send", async () => {
    const e = event({ providerEventId: "evt_1", type: "payment_failed" });

    const failed = await notifyDunning({
      event: e,
      outcome: "transitioned",
      appUrl: APP_URL,
      mailer: new BrokenMailer(),
    });
    expect(failed).toBe("send_failed");
    expect(await db.dunningNotice.count()).toBe(0);

    const retried = await notifyDunning({
      event: e,
      outcome: "transitioned",
      appUrl: APP_URL,
      mailer,
    });
    expect(retried).toBe("sent");
    expect(mailer.sent).toHaveLength(1);
  });

  it("records who was written to, and about what", async () => {
    await deliver(event({ providerEventId: "evt_1", type: "payment_failed" }));

    const row = await db.dunningNotice.findUniqueOrThrow({
      where: { providerEventId: "evt_1" },
    });
    expect(row.kind).toBe("past_due");
    expect(row.tenantId).toBe(tenantId);
    expect(row.to).toBe(only(mailer.sent).to);
  });
});
