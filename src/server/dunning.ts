/**
 * The dunning hooks: one mail when a renewal fails, one when a subscription
 * ends, and never a second copy of either.
 *
 * Deliberately not inside `applyEvent`. That function's job is to move a
 * status, and it must not be able to fail — the webhook route answers 200 once
 * the signature verifies, and a mail server that is down is not a reason to
 * make Stripe redeliver a status change that already landed. So the notice
 * runs after the transition, reads the outcome, and swallows its own failures.
 *
 * Idempotency is a primary key here too. `applyEvent` already claims the event
 * id, so a redelivery never reaches this code — but a manual replay, a
 * backfill, or a second caller added later would, and "we emailed this
 * customer once" is not a guarantee worth leaving to who happens to call
 * whom. The insert into DunningNotice is the claim.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { BillingEvent } from "@/domain/billing-event";
import { noticeForStatus } from "@/domain/dunning";
import { isPlanKey, PLANS } from "@/domain/entitlements";
import { statusForEvent } from "@/domain/subscription";
import { defaultLocale } from "@/i18n";
import { renderDunningEmail } from "@/emails/render";
import { type ApplyOutcome, subscriptionForEvent } from "./billing.service";
import { smtpMailer, type Mailer } from "./mailer";

export type DunningOutcome =
  /** Not a status change anyone needs a mail about, or one that never happened. */
  | "not_applicable"
  /** A notice for this event id has already gone out.  */
  | "duplicate"
  /** No subscription or tenant behind the event to write to. */
  | "not_found"
  /** Composed and handed to the mailer. */
  | "sent"
  /** The mailer refused it; the claim was released so a replay can try again. */
  | "send_failed";

export interface NotifyDunningInput {
  event: BillingEvent;
  /** What `applyEvent` did with it — the notice follows the transition. */
  outcome: ApplyOutcome;
  appUrl: string;
  mailer?: Mailer;
}

/**
 * Write to the customer about a status their subscription has just reached.
 *
 * Only `transitioned` earns a mail. A replay is `duplicate`, a cancellation
 * that arrived before the activation it followed is `no_transition`, and a
 * renewal on an already-active subscription is `renewed`: none of those moved
 * anything, so none of them is news.
 */
export async function notifyDunning(input: NotifyDunningInput): Promise<DunningOutcome> {
  if (input.outcome !== "transitioned") return "not_applicable";

  const status = statusForEvent(input.event.type);
  const kind = status && noticeForStatus(status);
  if (!kind) return "not_applicable";

  const subscription = await subscriptionForEvent(input.event);
  if (!subscription) return "not_found";

  const tenant = await db.tenant.findUnique({ where: { id: subscription.tenantId } });
  if (!tenant) return "not_found";

  // The claim IS the lock, as it is in applyEvent: a second attempt loses on
  // the primary key rather than reading a row that is not written yet.
  try {
    await db.dunningNotice.create({
      data: {
        providerEventId: input.event.providerEventId,
        tenantId: tenant.id,
        kind,
        to: tenant.email,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return "duplicate";
    }
    throw err;
  }

  const plan = isPlanKey(subscription.planKey) ? PLANS[subscription.planKey] : PLANS.free;
  const message = await renderDunningEmail(kind, {
    tenantName: tenant.name,
    planName: plan.name,
    // The pages are locale-prefixed and nothing records a tenant's language,
    // so mail links land on the default locale and next-intl takes it from
    // there if the reader has a preference.
    accountUrl: `${input.appUrl}/${defaultLocale}/account`,
    pricingUrl: `${input.appUrl}/${defaultLocale}`,
  });

  try {
    await (input.mailer ?? smtpMailer()).send({ to: tenant.email, ...message });
  } catch {
    // A row here means a mail went out. None did, so the claim is a lie that
    // would also block the retry — release it and let a later delivery try.
    await db.dunningNotice.delete({ where: { providerEventId: input.event.providerEventId } });
    return "send_failed";
  }

  return "sent";
}
