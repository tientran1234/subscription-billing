/**
 * Replaying one provider event: re-fetch it, put it back through the webhook's
 * own path, and write down who asked.
 *
 * This is not a second way to change a subscription. The event is read off the
 * gateway and normalized by the same adapter code a delivery goes through, then
 * handed to the same `applyEvent` and the same `notifyDunning`, in the order
 * the webhook route calls them — so every guarantee that holds for a delivery
 * holds here: the event id is claimed in `WebhookEvent`, the transition is
 * conditional in Postgres, and the mail is claimed before it is rendered. The
 * notice is deliberately not skipped as "already handled": the delivery being
 * replayed is one that never arrived, so the customer was never written to, and
 * the `DunningNotice` primary key is what stops a replay of one that did
 * arrive from writing to them twice.
 *
 * The audit row is written BEFORE the work and its outcome filled in after. It
 * is not a lock — idempotency is the event id's own primary key, and a replay
 * racing a live delivery is settled there — so claiming early costs nothing and
 * buys the row that matters most to whoever reads this table: an attempt that
 * died between the fetch and the apply is still attributable, and shows up as
 * an outcome nobody ever recorded.
 */
import { db } from "@/lib/db";
import type { IBillingProvider } from "@/domain/billing-event";
import { checkReplay, type ReplayRefusal } from "@/domain/replay";
import { applyEvent, subscriptionForEvent, type ApplyOutcome } from "./billing.service";
import { notifyDunning, type DunningOutcome } from "./dunning";
import type { Mailer } from "./mailer";

export interface ReplayInput {
  /** The id to re-fetch. Caller-supplied, so it may name no event at all. */
  providerEventId: string;
  /** The tenant the caller proved they may act for — never read off the body. */
  tenantId: string;
  /** Who asked. Recorded, not checked: there are no roles here yet. */
  userId: string;
  userEmail: string;
  appUrl: string;
  mailer?: Mailer;
}

export type ReplayResult =
  | { ok: true; outcome: ApplyOutcome; notified: DunningOutcome }
  | { ok: false; reason: ReplayRefusal };

export async function replayEvent(
  provider: IBillingProvider,
  input: ReplayInput,
): Promise<ReplayResult> {
  const attempt = await db.eventReplay.create({
    data: {
      providerEventId: input.providerEventId,
      tenantId: input.tenantId,
      userId: input.userId,
      userEmail: input.userEmail,
    },
  });
  const record = (outcome: string) =>
    db.eventReplay.update({ where: { id: attempt.id }, data: { outcome } });

  const event = await provider.fetchEvent(input.providerEventId);
  // The subscription is looked up before anything is applied, because it is
  // what says whose event this is — and by the same function applyEvent uses,
  // so the row checked here is the row that moves.
  const resolved = checkReplay(
    input.tenantId,
    event,
    event ? await subscriptionForEvent(event) : null,
  );
  if (!resolved.ok) {
    await record(resolved.reason);
    return resolved;
  }

  const outcome = await applyEvent(provider.name, resolved.event);
  // Recorded before the mail goes out: what the audit is for is what happened
  // to the subscription, and a mailer that throws must not be able to leave
  // that unsaid.
  await record(outcome);

  const notified = await notifyDunning({
    event: resolved.event,
    outcome,
    appUrl: input.appUrl,
    mailer: input.mailer,
  });
  return { ok: true, outcome, notified };
}
