/**
 * Writing to a workspace about its own ceiling: one mail as the month
 * approaches it, one when it stops serving calls, and never a second copy of
 * either in the same month.
 *
 * Called from the request that crossed the line rather than from a job, because
 * the news is "your key has just started being refused" and a nightly sweep
 * would say it a day late — and because the figures are already in that
 * request's hands: it metered the call and read the cap to decide whether to
 * serve it. It swallows its own failures for the same reason the dunning hook
 * does: the gate in front of the feature must not start refusing calls because
 * a mail server is down.
 *
 * Idempotency is a primary key, as everywhere else here, and this is the one
 * notice whose key could not be an event id: nothing was delivered. A counter
 * that has crossed a line stays crossed for every call after it, so without a
 * claim a workspace at 81% of its cap would be mailed once per request for the
 * rest of the month. `CapNotice` is keyed by (tenant, period, kind): the first
 * request past the line writes the row and sends, every one after it loses the
 * insert, and the month rolling over is what makes the next one news again.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { capWarningFor } from "@/domain/cap-warning";
import { isPlanKey, PLANS } from "@/domain/entitlements";
import { UNCAPPED, type SpendCap } from "@/domain/spend-cap";
import { defaultLocale } from "@/i18n";
import { renderCapWarningEmail } from "@/emails/render";
import { smtpMailer, type Mailer } from "./mailer";
import { currentPeriod } from "./usage";

export type CapWarningOutcome =
  /** No ceiling, or a month that has not reached a line worth mailing about. */
  | "not_applicable"
  /** This month's notice of that kind has already gone out. */
  | "duplicate"
  /** No tenant behind the request to write to. */
  | "not_found"
  /** Composed and handed to the mailer. */
  | "sent"
  /** The mailer refused it; the claim was released so a later call can try. */
  | "send_failed";

export interface NotifyCapWarningInput {
  /** The tenant the caller proved they may act for — never read off the body. */
  tenantId: string;
  /** Units past the plan's quota this month, as `meter` has just counted them. */
  units: number;
  /** The ceiling they were measured against, as the route read it. */
  cap: SpendCap;
  /**
   * The plan to name in the mail. Passed in from the entitlements the gate
   * derived, so the mail cannot credit a workspace with a plan the call it is
   * about was not served under.
   */
  planKey: string;
  appUrl: string;
  /** Which month the units belong to. Omitted means the one the clock is in. */
  period?: string;
  now?: Date;
  mailer?: Mailer;
}

/**
 * Write to the workspace if this call took its month to a line it has not been
 * told about yet.
 */
export async function notifyCapWarning(
  input: NotifyCapWarningInput,
): Promise<CapWarningOutcome> {
  const kind = capWarningFor(input.units, input.cap);
  // Decided before anything is read: the rule is pure, so every request that is
  // nowhere near a ceiling — which is nearly all of them — costs no query. The
  // second half of the condition is one `capWarningFor` has already made, and it
  // is repeated because the claim stores a ceiling as a number and the compiler
  // is right to ask which it is.
  if (kind === null || input.cap === UNCAPPED) return "not_applicable";
  const cap = input.cap;

  const tenant = await db.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) return "not_found";

  const period = input.period ?? currentPeriod(input.now ?? new Date());

  // The claim IS the lock, as it is in applyEvent and in a dunning notice: the
  // second request past the line loses on the primary key rather than reading a
  // row the first one has not written yet.
  try {
    await db.capNotice.create({
      data: {
        tenantId: tenant.id,
        period,
        kind,
        units: input.units,
        cap,
        to: tenant.email,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return "duplicate";
    }
    throw err;
  }

  const plan = isPlanKey(input.planKey) ? PLANS[input.planKey] : PLANS.free;
  const message = await renderCapWarningEmail(kind, {
    tenantName: tenant.name,
    planName: plan.name,
    units: input.units,
    cap,
    // The pages are locale-prefixed and nothing records a tenant's language, so
    // the link lands on the default locale, as a dunning notice's does.
    accountUrl: `${input.appUrl}/${defaultLocale}/account`,
  });

  try {
    await (input.mailer ?? smtpMailer()).send({ to: tenant.email, ...message });
  } catch {
    // A row here means a mail went out. None did, so the claim is a lie that
    // would also silence the rest of the month — release it and let a later
    // call past the same line try again.
    await db.capNotice.delete({
      where: { tenantId_period_kind: { tenantId: tenant.id, period, kind } },
    });
    return "send_failed";
  }

  return "sent";
}
