import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import Link from "next/link";
import { PLANS, type PlanKey } from "@/domain/entitlements";
import { resolveTenant } from "@/domain/membership";
import { QUOTE_TTL_SECONDS } from "@/domain/plan-change";
import { auth } from "@/lib/auth";
import { billingProvider } from "@/providers";
import {
  currentPlanFor,
  entitlementsForTenant,
  listInvoiceHistory,
} from "@/server/billing.service";
import { principalFrom, TENANT_HEADER } from "@/server/with-session";
import { InvoiceHistory } from "./invoice-history";
import { PlanPicker } from "./plan-picker";
import { PortalLink } from "./portal-link";

export default async function AccountPage({
  params,
}: {
  params: Promise<{ locale: string }>;
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

  // Read from the provider on this request, which is the point: an invoice is
  // the provider's own document and goes on changing after it is raised, so a
  // copy here would be a second answer to what this workspace was charged.
  const invoices = await listInvoiceHistory(billingProvider(), {
    tenantId: resolved.tenantId,
  });

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

      <InvoiceHistory
        history={invoices}
        locale={locale}
        labels={{
          heading: t("invoices"),
          empty: t("invoicesEmpty"),
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
