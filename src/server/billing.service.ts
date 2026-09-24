/**
 * The business layer. The only place a subscription's status changes.
 *
 * Providers verify and normalize; this file decides. That split is what lets a
 * second provider be added without reopening any of the logic below.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { BillingEvent, IBillingProvider } from "@/domain/billing-event";
import { predecessorsOf, statusForEvent } from "@/domain/subscription";
import { entitlementsFor, type Entitlements } from "@/domain/entitlements";

export type ApplyOutcome =
  /** Replayed delivery — already processed, nothing done. */
  | "duplicate"
  /** Event we do not act on; recorded so it is not reprocessed. */
  | "ignored"
  /** No subscription matches the refs on the event. */
  | "not_found"
  /** Status moved. */
  | "transitioned"
  /** Already ACTIVE and this was a renewal — period extended, status untouched. */
  | "renewed"
  /** The transition is not legal from the current status: out-of-order or lost race. */
  | "no_transition";

export interface StartCheckoutInput {
  tenantId: string;
  planKey: string;
  priceRef: string;
  customerEmail?: string;
  appUrl: string;
}

export async function startCheckout(
  provider: IBillingProvider,
  input: StartCheckoutInput,
): Promise<{ subscriptionId: string; checkoutUrl: string }> {
  // Persist PENDING *before* calling the provider. Stripe can deliver
  // checkout.session.completed while we are still awaiting the create() call;
  // if the row does not exist yet, that webhook has nothing to attach to.
  const subscription = await db.subscription.create({
    data: {
      tenantId: input.tenantId,
      planKey: input.planKey,
      status: "PENDING",
      provider: provider.name,
    },
  });

  const { checkoutUrl, checkoutRef } = await provider.createCheckout({
    subscriptionId: subscription.id,
    planKey: input.planKey,
    priceRef: input.priceRef,
    customerEmail: input.customerEmail,
    successUrl: `${input.appUrl}/billing/success`,
    cancelUrl: `${input.appUrl}/billing/cancel`,
  });

  await db.subscription.update({ where: { id: subscription.id }, data: { checkoutRef } });
  return { subscriptionId: subscription.id, checkoutUrl };
}

export async function applyEvent(
  providerName: string,
  event: BillingEvent,
): Promise<ApplyOutcome> {
  // 1. Claim the event id. The insert IS the lock: a replay loses on the
  //    primary key instead of being processed a second time.
  try {
    await db.webhookEvent.create({
      data: {
        providerEventId: event.providerEventId,
        provider: providerName,
        type: event.type,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return "duplicate";
    }
    throw err;
  }

  const target = statusForEvent(event.type);
  if (!target) return "ignored";

  const refs = [
    event.providerRef ? { providerRef: event.providerRef } : null,
    event.checkoutRef ? { checkoutRef: event.checkoutRef } : null,
  ].filter((r): r is { providerRef: string } | { checkoutRef: string } => r !== null);
  if (refs.length === 0) return "not_found";

  const subscription = await db.subscription.findFirst({ where: { OR: refs } });
  if (!subscription) return "not_found";

  // 2. Transition conditionally. `status IN (legal predecessors)` is checked by
  //    Postgres, not by Node, so two deliveries racing each other produce one
  //    winner and one no-op rather than two writes.
  const { count } = await db.subscription.updateMany({
    where: { id: subscription.id, status: { in: predecessorsOf(target) } },
    data: {
      status: target,
      ...(event.providerRef ? { providerRef: event.providerRef } : {}),
      ...(event.customerRef ? { customerRef: event.customerRef } : {}),
      ...(event.currentPeriodEnd ? { currentPeriodEnd: event.currentPeriodEnd } : {}),
    },
  });
  if (count === 1) return "transitioned";

  // 3. A renewal on an already-ACTIVE subscription is not a status change, but
  //    it does move the period end. Without this, ACTIVE→ACTIVE would be
  //    dropped and the subscription would look expired at the old date.
  if (target === "ACTIVE" && subscription.status === "ACTIVE" && event.currentPeriodEnd) {
    await db.subscription.update({
      where: { id: subscription.id },
      data: {
        currentPeriodEnd: event.currentPeriodEnd,
        ...(event.customerRef ? { customerRef: event.customerRef } : {}),
      },
    });
    return "renewed";
  }

  return "no_transition";
}

/** What this tenant may do right now, derived from their newest subscription. */
export async function entitlementsForTenant(tenantId: string): Promise<Entitlements> {
  const subscription = await db.subscription.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription) return entitlementsFor("free", "NONE");
  return entitlementsFor(subscription.planKey, subscription.status);
}
