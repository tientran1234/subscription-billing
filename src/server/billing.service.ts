/**
 * The business layer. The only place a subscription's status changes.
 *
 * Providers verify and normalize; this file decides. That split is what lets a
 * second provider be added without reopening any of the logic below.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type {
  BillingEvent,
  IBillingProvider,
  PlanChangePreview,
} from "@/domain/billing-event";
import {
  checkPlanChange,
  isQuoteUsable,
  planKeyForPaidInvoice,
  seatsForPaidInvoice,
  type CurrentPlan,
  type PlanChangeRefusal,
} from "@/domain/plan-change";
import {
  DEFAULT_CURRENCY,
  checkCurrency,
  type CurrencyRefusal,
} from "@/domain/currency";
import { MIN_SEATS, checkSeats, type SeatRefusal } from "@/domain/seats";
import { INVOICE_HISTORY_LIMIT, historyOf, type Invoice } from "@/domain/invoice";
import { portalCustomerFor } from "@/domain/portal";
import { preferredLocalesFor } from "@/domain/notice-locale";
import type { Locale } from "@/i18n";
import { predecessorsOf, statusForEvent } from "@/domain/subscription";
import { entitlementsFor, trialDaysFor, type Entitlements } from "@/domain/entitlements";

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
  /** Already ACTIVE and the paid invoice named another plan or seat count — repriced, status untouched. */
  | "repriced"
  /** The transition is not legal from the current status: out-of-order or lost race. */
  | "no_transition";

export interface StartCheckoutInput {
  tenantId: string;
  planKey: string;
  priceRef: string;
  /**
   * Provider-side price id for the metered add-on, for a plan that bills past
   * its quota. Omitted buys a subscription whose quota is a ceiling.
   */
  overagePriceRef?: string;
  /** Seats to buy. Omitted means the one the person checking out occupies. */
  seats?: number;
  /**
   * Currency to bill in — the one the customer was quoted. Omitted means the
   * default, which is what a client that has never heard of the others sends.
   */
  currency?: string;
  customerEmail?: string;
  appUrl: string;
}

export type StartCheckoutResult =
  | { ok: true; subscriptionId: string; checkoutUrl: string }
  /** Refused, so no row was written and no session opened. */
  | { ok: false; reason: SeatRefusal | CurrencyRefusal };

/**
 * Seats occupied right now.
 *
 * A membership is the only thing that takes one: a person who can sign in and
 * act for this workspace. Nothing yet adds a second member — see the README —
 * so for most tenants this is one, but the floor is read rather than assumed,
 * because the day invites arrive is not the day to remember seats had a rule.
 */
async function seatsInUse(tenantId: string): Promise<number> {
  return db.membership.count({ where: { tenantId } });
}

export async function startCheckout(
  provider: IBillingProvider,
  input: StartCheckoutInput,
): Promise<StartCheckoutResult> {
  const seats = input.seats ?? MIN_SEATS;
  const currency = input.currency ?? DEFAULT_CURRENCY;

  // Both checked before the row exists, not after. A subscription for fewer
  // seats than the workspace already fills would be sold access it cannot hand
  // out; one in a currency no plan is priced in would be a session nobody
  // could pay, and the row left behind is what a late webhook attaches to.
  const currencyRefusal = checkCurrency(currency);
  if (currencyRefusal) return { ok: false, reason: currencyRefusal };

  const refusal = checkSeats(seats, await seatsInUse(input.tenantId));
  if (refusal) return { ok: false, reason: refusal };

  // Persist PENDING *before* calling the provider. Stripe can deliver
  // checkout.session.completed while we are still awaiting the create() call;
  // if the row does not exist yet, that webhook has nothing to attach to.
  const subscription = await db.subscription.create({
    data: {
      tenantId: input.tenantId,
      planKey: input.planKey,
      status: "PENDING",
      provider: provider.name,
      seats,
      currency,
      // Recorded because it is part of what was bought, like the seats and the
      // currency: a subscription opened without the add-on has no meter at the
      // provider, so nothing may let it past its quota later on.
      meteredOverage: Boolean(input.overagePriceRef),
    },
  });

  const { checkoutUrl, checkoutRef } = await provider.createCheckout({
    subscriptionId: subscription.id,
    planKey: input.planKey,
    priceRef: input.priceRef,
    // Read off the plan here rather than accepted from the route: a trial is
    // something we sell, so no caller gets to ask for a longer one.
    trialDays: trialDaysFor(input.planKey),
    overagePriceRef: input.overagePriceRef,
    seats,
    currency,
    customerEmail: input.customerEmail,
    successUrl: `${input.appUrl}/billing/success`,
    cancelUrl: `${input.appUrl}/billing/cancel`,
  });

  await db.subscription.update({ where: { id: subscription.id }, data: { checkoutRef } });
  return { ok: true, subscriptionId: subscription.id, checkoutUrl };
}

/**
 * Which customer at the provider this tenant is, by the rule in
 * domain/portal.ts: the newest one across all their subscription rows,
 * whatever each row's status.
 *
 * Shared by the portal link and the invoice history because both answer that
 * one question, and two lookups written twice would be two chances to answer
 * it differently — one page opening the portal of a customer whose invoices
 * the other is listing. Resolved from the tenant the caller already proved
 * they may act for and never from the request, which is what keeps the worst
 * either of them can do their own billing.
 */
async function providerCustomerFor(tenantId: string): Promise<string | null> {
  const subscriptions = await db.subscription.findMany({
    where: { tenantId },
    select: { customerRef: true, createdAt: true },
  });
  return portalCustomerFor(subscriptions);
}

export type PortalResult =
  | { ok: true; portalUrl: string }
  /** Nothing to manage: this tenant has no customer with the provider yet. */
  | { ok: false; reason: "no_customer" };

/**
 * A link into the provider's billing portal for the tenant the caller already
 * proved they may act for.
 *
 * The customer is looked up from that tenant's own rows and is never accepted
 * from the request, so the worst a caller can do with this endpoint is open
 * their own portal. Nothing here changes a subscription: cancelling and
 * resuming happen at the provider and come back as webhooks, which is what
 * keeps applyEvent the only writer of `status`.
 */
export async function startPortalSession(
  provider: IBillingProvider,
  input: { tenantId: string; appUrl: string },
): Promise<PortalResult> {
  const customerRef = await providerCustomerFor(input.tenantId);
  if (!customerRef) return { ok: false, reason: "no_customer" };

  const { portalUrl } = await provider.createPortalSession({
    customerRef,
    returnUrl: `${input.appUrl}/account`,
  });
  return { ok: true, portalUrl };
}

export type InvoiceHistoryResult =
  | { ok: true; invoices: Invoice[] }
  /** Nothing billed yet: this tenant has no customer with the provider. */
  | { ok: false; reason: "no_customer" }
  /** The provider could not be read just now. */
  | { ok: false; reason: "unavailable" };

/**
 * The tenant's issued invoices, newest first, read from the provider on this
 * request and stored nowhere.
 *
 * That is the whole point of it: an invoice is the provider's document, it
 * changes after it is raised, and a copy here would go stale into a second
 * answer about what a customer was charged. The links come back with it rather
 * than being minted per click like the portal's — a provider's hosted invoice
 * and PDF live on the invoice itself, so one read into this page is still the
 * same document tomorrow.
 *
 * A provider that cannot be reached is an outcome rather than a throw. The
 * account page holds the plan this workspace is on, the change it may make and
 * the link into the portal; a gateway having a bad minute must cost the list of
 * documents and not the page around it.
 */
export async function listInvoiceHistory(
  provider: IBillingProvider,
  input: { tenantId: string },
): Promise<InvoiceHistoryResult> {
  const customerRef = await providerCustomerFor(input.tenantId);
  if (!customerRef) return { ok: false, reason: "no_customer" };

  try {
    const page = await provider.listInvoices({
      customerRef,
      limit: INVOICE_HISTORY_LIMIT,
    });
    return { ok: true, invoices: historyOf(page.invoices) };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export type NoticeLocaleSyncOutcome =
  /** Nothing billed yet: this tenant has no customer with the provider to tell. */
  | "no_customer"
  /** The provider could not be reached, or refused; our own column stands. */
  | "unavailable"
  /** The provider's customer now carries the language too. */
  | "recorded";

/**
 * Tell the provider's own customer which language to compose its mail in.
 *
 * Called after the column is written and never instead of it. The column is
 * ours and decides the mail this application composes; the gateway's copy
 * decides the receipts and the card-expiry warnings it sends on its own
 * account. One of those we can guarantee and the other we can only ask for, so
 * a gateway having a bad minute is an outcome here rather than a throw: a
 * customer who has just chosen Vietnamese has chosen it, and losing that to an
 * outage at Stripe — or making them click again to find out — would be paying
 * for the half we do not own with the half we do. The next time they change it
 * asks again, and `preferred_locales` only ever affects what the gateway writes
 * next.
 *
 * The customer is resolved from the tenant through the same lookup the portal
 * link and the invoice history use, so a workspace cannot name someone else's
 * customer and set a language on it.
 */
export async function syncNoticeLocale(
  provider: IBillingProvider,
  input: { tenantId: string; locale: Locale },
): Promise<NoticeLocaleSyncOutcome> {
  const customerRef = await providerCustomerFor(input.tenantId);
  // A workspace that has never subscribed has nothing on the gateway to write
  // to, and will carry the column across on the checkout it eventually opens.
  if (!customerRef) return "no_customer";

  try {
    await provider.setCustomerLocale({
      customerRef,
      preferredLocales: preferredLocalesFor(input.locale),
    });
    return "recorded";
  } catch {
    return "unavailable";
  }
}

export type PlanChangeFailure =
  | PlanChangeRefusal
  /** Nothing the provider knows about yet — no subscription, or no webhook for it. */
  | "no_subscription"
  /** The quote is too old to bill against; take a fresh preview. */
  | "stale_quote";

export interface PlanChangeInput {
  tenantId: string;
  planKey: string;
  /** Provider-side price id for that plan. */
  priceRef: string;
  /** Seats to be billed after the change. Omitted keeps the count as it is. */
  seats?: number;
}

export type PreviewResult =
  | { ok: true; preview: PlanChangePreview }
  | { ok: false; reason: PlanChangeFailure };

export type ConfirmResult = { ok: true } | { ok: false; reason: PlanChangeFailure };

/**
 * The subscription a plan change would act on: this tenant's newest, and only
 * if the provider is already billing it. Resolved from the tenant, never from
 * the request, for the same reason the portal is.
 */
async function repriceable(
  tenantId: string,
  target: { planKey: string; seats?: number },
): Promise<
  | { ok: true; providerRef: string; seats: number; currency: string }
  | { ok: false; reason: PlanChangeFailure }
> {
  const subscription = await db.subscription.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription?.providerRef) return { ok: false, reason: "no_subscription" };

  const check = checkPlanChange(
    { ...subscription, seatsInUse: await seatsInUse(tenantId) },
    target,
  );
  if (!check.ok) return { ok: false, reason: check.reason };

  // The seat count the rule settled on, not the one asked for: a plan move that
  // named no seats keeps the ones already paid for, and quoting anything else
  // would bill for a change the customer did not request.
  //
  // The currency comes straight off the row and is not a parameter at all. It
  // was settled at checkout and the provider will not move a live subscription
  // into another one, so there is nowhere else it could honestly come from.
  return {
    ok: true,
    providerRef: subscription.providerRef,
    seats: check.seats,
    currency: subscription.currency,
  };
}

/** What the change would cost. Charges nothing and changes nothing. */
export async function previewPlanChange(
  provider: IBillingProvider,
  input: PlanChangeInput,
): Promise<PreviewResult> {
  const found = await repriceable(input.tenantId, input);
  if (!found.ok) return found;

  const preview = await provider.previewPlanChange({
    providerRef: found.providerRef,
    priceRef: input.priceRef,
    seats: found.seats,
    currency: found.currency,
  });
  return { ok: true, preview };
}

/**
 * Ask the provider to move the plan, billing the proration the customer was
 * shown — `prorationDate` comes straight back from their preview, and a quote
 * old enough that the provider would now compute a different amount is refused
 * rather than silently repriced.
 *
 * Nothing local changes here. `planKey` moves when the invoice for it is paid
 * and that webhook reaches applyEvent, so a change the customer's card declines
 * leaves them on the plan they are still paying for.
 */
export async function confirmPlanChange(
  provider: IBillingProvider,
  input: PlanChangeInput & { prorationDate: Date },
): Promise<ConfirmResult> {
  if (!isQuoteUsable(input.prorationDate)) return { ok: false, reason: "stale_quote" };

  const found = await repriceable(input.tenantId, input);
  if (!found.ok) return found;

  await provider.changePlan({
    providerRef: found.providerRef,
    priceRef: input.priceRef,
    planKey: input.planKey,
    seats: found.seats,
    currency: found.currency,
    prorationDate: input.prorationDate,
  });
  return { ok: true };
}

/**
 * The subscription an event is about, found by whichever reference it carries.
 *
 * Shared with the dunning notices, which need the same row to know who to
 * write to: two lookups written twice would be two chances for one of them to
 * pick a different subscription than the one whose status just moved.
 */
export async function subscriptionForEvent(event: BillingEvent) {
  const refs = [
    event.providerRef ? { providerRef: event.providerRef } : null,
    event.checkoutRef ? { checkoutRef: event.checkoutRef } : null,
  ].filter((r): r is { providerRef: string } | { checkoutRef: string } => r !== null);
  if (refs.length === 0) return null;

  return db.subscription.findFirst({ where: { OR: refs } });
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

  const subscription = await subscriptionForEvent(event);
  if (!subscription) return "not_found";

  // 2. A paid invoice may also move the plan and the seat count — that is how a
  //    mid-cycle change reaches us, since nothing writes either when the change
  //    is requested.
  const nextPlanKey = target === "ACTIVE" ? planKeyForPaidInvoice(subscription, event) : null;
  const nextSeats = target === "ACTIVE" ? seatsForPaidInvoice(subscription, event) : null;

  // 3. Transition conditionally. `status IN (legal predecessors)` is checked by
  //    Postgres, not by Node, so two deliveries racing each other produce one
  //    winner and one no-op rather than two writes.
  const { count } = await db.subscription.updateMany({
    where: { id: subscription.id, status: { in: predecessorsOf(target) } },
    data: {
      status: target,
      ...(event.providerRef ? { providerRef: event.providerRef } : {}),
      ...(event.customerRef ? { customerRef: event.customerRef } : {}),
      ...(event.currentPeriodEnd ? { currentPeriodEnd: event.currentPeriodEnd } : {}),
      ...(nextPlanKey ? { planKey: nextPlanKey } : {}),
      ...(nextSeats ? { seats: nextSeats } : {}),
    },
  });
  if (count === 1) return "transitioned";

  // 4. A renewal or a reprice on an already-ACTIVE subscription is not a status
  //    change, but it does move the period end, the plan and the seats. Without
  //    this, ACTIVE→ACTIVE would be dropped: the subscription would look
  //    expired at the old date, and an upgrade or a seat the customer has paid
  //    for would never take effect.
  if (
    target === "ACTIVE" &&
    subscription.status === "ACTIVE" &&
    (event.currentPeriodEnd || nextPlanKey || nextSeats)
  ) {
    await db.subscription.update({
      where: { id: subscription.id },
      data: {
        ...(event.currentPeriodEnd ? { currentPeriodEnd: event.currentPeriodEnd } : {}),
        ...(event.customerRef ? { customerRef: event.customerRef } : {}),
        ...(nextPlanKey ? { planKey: nextPlanKey } : {}),
        ...(nextSeats ? { seats: nextSeats } : {}),
      },
    });
    return nextPlanKey || nextSeats ? "repriced" : "renewed";
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
  return entitlementsFor(
    subscription.planKey,
    subscription.status,
    subscription.seats,
    subscription.meteredOverage,
  );
}

/**
 * The plan and status a plan change would act on, or `null` for a tenant that
 * has never reached checkout — there is no plan to move, and that customer
 * subscribes rather than changes.
 *
 * The subscription's own plan, deliberately, and not the entitlements derived
 * from it: PAST_DUE keeps paid access, so the derived plan reads "pro" while
 * the subscription behind it is one no proration may be charged against. A
 * picker fed entitlements would offer a change the route then refuses.
 *
 * Seats in use come along for the same reason: the picker has to be able to
 * draw the floor the route enforces, rather than let a customer ask for a
 * reduction that is refused once they have confirmed it.
 */
export async function currentPlanFor(tenantId: string): Promise<CurrentPlan | null> {
  const subscription = await db.subscription.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription) return null;
  return {
    planKey: subscription.planKey,
    status: subscription.status,
    seats: subscription.seats,
    seatsInUse: await seatsInUse(tenantId),
  };
}
