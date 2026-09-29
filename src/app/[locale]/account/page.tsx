import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import Link from "next/link";
import { PLANS } from "@/domain/entitlements";
import { resolveTenant } from "@/domain/membership";
import { QUOTE_TTL_SECONDS, planChangeOptions } from "@/domain/plan-change";
import { auth } from "@/lib/auth";
import { currentPlanFor, entitlementsForTenant } from "@/server/billing.service";
import { principalFrom, TENANT_HEADER } from "@/server/with-session";
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
  // be charged against. No subscription means no options at all — the picker
  // draws nothing, and the pricing page is where that customer starts.
  const current = await currentPlanFor(resolved.tenantId);
  const options = current ? planChangeOptions(current) : [];
  const offers = options
    .filter((option) => option.refusal === null)
    .map((option) => ({
      planKey: option.planKey,
      name: PLANS[option.planKey].name,
      choose: t("changeTo", { plan: PLANS[option.planKey].name }),
    }));

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
        </ul>
      </section>

      <PlanPicker
        offers={offers}
        inactive={options.some((option) => option.refusal === "not_billable")}
        locale={locale}
        labels={{
          heading: t("changeTitle"),
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
