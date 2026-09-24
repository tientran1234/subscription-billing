import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import Link from "next/link";
import { PLANS } from "@/domain/entitlements";
import { resolveTenant } from "@/domain/membership";
import { auth } from "@/lib/auth";
import { entitlementsForTenant } from "@/server/billing.service";
import { principalFrom, TENANT_HEADER } from "@/server/with-session";
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

      <PortalLink
        label={t("portal")}
        opening={t("portalOpening")}
        empty={t("portalEmpty")}
        failed={t("portalFailed")}
      />
      <p className="sub">{t("portalNote")}</p>
      {back}
    </main>
  );
}
