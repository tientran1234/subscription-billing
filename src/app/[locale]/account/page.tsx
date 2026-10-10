import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import Link from "next/link";
import { PLANS, type PlanKey } from "@/domain/entitlements";
import { resolveTenant } from "@/domain/membership";
import { noticeLocaleFor } from "@/domain/notice-locale";
import { QUOTE_TTL_SECONDS } from "@/domain/plan-change";
import { auth } from "@/lib/auth";
import { billingProvider } from "@/providers";
import {
  currentPlanFor,
  entitlementsForTenant,
  listInvoiceHistory,
} from "@/server/billing.service";
import { spendCapFor } from "@/server/spend-cap";
import { tenantLocale } from "@/server/tenant-locale";
import { principalFrom, TENANT_HEADER } from "@/server/with-session";
import { InvoiceHistory } from "./invoice-history";
import { NoticeLocaleForm } from "./notice-locale-form";
import { PlanPicker } from "./plan-picker";
import { PortalLink } from "./portal-link";
import { SpendCapForm } from "./spend-cap-form";

/** Which window of the invoice archive the url is asking for. */
const INVOICE_CURSOR_PARAM = "invoiceAfter";

/**
 * This page at a window of the invoice archive. The fragment is what makes the
 * link usable: the list is near the foot of a long page, and a customer paging
 * it would otherwise land back at the top of their plan on every click.
 */
function invoicesHref(locale: string, cursor: string | null): string {
  const query = cursor ? `?${INVOICE_CURSOR_PARAM}=${encodeURIComponent(cursor)}` : "";
  return `/${locale}/account${query}#invoices`;
}

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = await getTranslations("account");
  const back = <Link href={`/${locale}`}>{t("backToPricing")}</Link>;

  const principal = principalFrom(await auth());
  if (!principal) {
    return (
      <main>
        <h1>{t("title")}</h1>
        <p className="sub">{t("signedOut")}</p>
        <Link href="/api/auth/signin">{t("signIn")}</Link>
      </main>
    );
  }

  // The same rule the API routes run, from the same pure function: a page that
  // resolved the tenant its own way would be a second answer to go stale.
  const resolved = resolveTenant(principal, (await headers()).get(TENANT_HEADER));
  if (!resolved.ok) {
    return (
      <main>
        <h1>{t("title")}</h1>
        <p className="sub">{resolved.reason === "ambiguous" ? t("ambiguous") : t("noTenant")}</p>
        {back}
      </main>
    );
  }

  const entitlements = await entitlementsForTenant(resolved.tenantId);

  // Read from the subscription rather than from the entitlements above: the
  // two disagree on PAST_DUE, and it is the subscription the proration would
  // be charged against. No subscription means the picker draws nothing, and
  // the pricing page is where that customer starts.
  //
  // Which plans get a button is decided in the picker, not here: the answer
  // moves as the customer changes the seat count, and a set filtered on the
  // server would be the set for the count they started with.
  const current = await currentPlanFor(resolved.tenantId);
  const plans = (Object.keys(PLANS) as PlanKey[]).map((planKey) => ({
    planKey,
    name: PLANS[planKey].name,
    choose: t("changeTo", { plan: PLANS[planKey].name }),
  }));

  // Which window of the invoice archive to draw. The gateway's own cursor, so
  // it is passed through rather than parsed: nothing here can tell a position
  // the gateway would accept from one it would not, and the one it refuses
  // comes back as a list it could not read.
  const raw = await searchParams;
  const after = Array.isArray(raw[INVOICE_CURSOR_PARAM])
    ? raw[INVOICE_CURSOR_PARAM][0]
    : raw[INVOICE_CURSOR_PARAM];

  // Read from the provider on this request, which is the point: an invoice is
  // the provider's own document and goes on changing after it is raised, so a
  // copy here would be a second answer to what this workspace was charged.
  const invoices = await listInvoiceHistory(billingProvider(), {
    tenantId: resolved.tenantId,
    startingAfter: after,
  });

  // The cap is drawn where it does something, which is where the quota is a
  // threshold: on a plan that stops at its allowance there is no bill to put a
  // ceiling under, and a form offering one would be a setting with no effect.
  const cap = entitlements.meteredOverage ? await spendCapFor(resolved.tenantId) : undefined;

  // The language a notice would go out in today, not the raw column: the
  // sentence under the form is about what we would send, and a workspace that
  // has never chosen is already being written to in something.
  const noticeLocale = noticeLocaleFor(await tenantLocale(resolved.tenantId));

  return (
    <main>
      <h1>{t("title")}</h1>
      <p className="sub">{t("subtitle")}</p>

      <section className="plan">
        <h2 style={{ margin: "0 0 12px", fontSize: "1rem" }}>
          {PLANS[entitlements.planKey].name}
        </h2>
        <ul className="features">
          {entitlements.features.map((f) => (
            <li key={f}>{f}</li>
          ))}
          <li>{t("seats", { count: entitlements.seats })}</li>
        </ul>
      </section>

      <PlanPicker
        current={current}
        plans={plans}
        locale={locale}
        labels={{
          heading: t("changeTitle"),
          seats: t("changeSeats"),
          seatsFloor: t("changeSeatsFloor", { count: current?.seatsInUse ?? 1 }),
          changeSeats: t("changeSeatsOnly"),
          quoting: t("changeQuoting"),
          dueNow: t("changeDueNow"),
          dueNothing: t("changeDueNothing"),
          nextInvoice: t("changeNextInvoice"),
          holds: t("changeHolds", { minutes: QUOTE_TTL_SECONDS / 60 }),
          confirm: t("changeConfirm"),
          confirming: t("changeConfirming"),
          back: t("changeBack"),
          requested: t("changeRequested"),
          inactive: t("changeInactive"),
          expired: t("changeExpired"),
          changed: t("changeChanged"),
          failed: t("changeFailed"),
        }}
      />

      {cap === undefined ? null : (
        <SpendCapForm
          cap={cap}
          labels={{
            heading: t("capTitle"),
            units: t("capUnits"),
            current: t("capCurrent", { count: cap ?? 0 }),
            uncapped: t("capUncapped"),
            save: t("capSave"),
            saving: t("capSaving"),
            lift: t("capLift"),
            saved: t("capSaved"),
            invalid: t("capInvalid"),
            failed: t("capFailed"),
            note: t("capNote"),
          }}
        />
      )}

      <NoticeLocaleForm
        locale={noticeLocale}
        labels={{
          heading: t("noticeTitle"),
          field: t("noticeField"),
          current: t("noticeCurrent", { language: t(`language.${noticeLocale}`) }),
          save: t("noticeSave"),
          saving: t("noticeSaving"),
          saved: t("noticeSaved"),
          failed: t("noticeFailed"),
          note: t("noticeNote"),
          // Written out rather than folded over the locales, so adding one to
          // src/i18n.ts is a compile error here instead of a blank option.
          names: {
            en: t("language.en"),
            vi: t("language.vi"),
          },
        }}
      />

      <InvoiceHistory
        history={invoices}
        locale={locale}
        older={
          invoices.ok && invoices.nextCursor ? invoicesHref(locale, invoices.nextCursor) : null
        }
        latest={after ? invoicesHref(locale, null) : null}
        labels={{
          heading: t("invoices"),
          empty: t("invoicesEmpty"),
          end: t("invoicesEnd"),
          older: t("invoicesOlder"),
          latest: t("invoicesLatest"),
          unavailable: t("invoicesUnavailable"),
          note: t("invoicesNote"),
          date: t("invoicesDate"),
          number: t("invoicesNumber"),
          status: t("invoicesStatus"),
          total: t("invoicesTotal"),
          document: t("invoicesDocument"),
          view: t("invoicesView"),
          pdf: t("invoicesPdf"),
          // Written out rather than folded over the statuses, so adding one
          // to the union is a compile error here instead of a blank cell.
          statuses: {
            draft: t("invoiceStatus.draft"),
            open: t("invoiceStatus.open"),
            paid: t("invoiceStatus.paid"),
            void: t("invoiceStatus.void"),
            uncollectible: t("invoiceStatus.uncollectible"),
          },
        }}
      />

      <PortalLink
        label={t("portal")}
        opening={t("portalOpening")}
        empty={t("portalEmpty")}
        failed={t("portalFailed")}
      />
      <p className="sub">{t("portalNote")}</p>
      <p>
        <Link href={`/${locale}/admin`}>{t("transactions")}</Link>
      </p>
      {back}
    </main>
  );
}
