import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { PLANS } from "@/domain/entitlements";
import { locales } from "@/i18n";

export default async function PricingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("pricing");

  return (
    <main>
      <nav className="locales">
        {locales.map((l) => (
          <Link key={l} href={`/${l}`} style={{ fontWeight: l === locale ? 600 : 400 }}>
            {l.toUpperCase()}
          </Link>
        ))}
      </nav>

      <h1>{t("title")}</h1>
      <p className="sub">{t("subtitle")}</p>

      <div className="plans">
        {Object.entries(PLANS).map(([key, plan]) => (
          <section key={key} className="plan">
            <h2 style={{ margin: "0 0 12px", fontSize: "1rem" }}>{plan.name}</h2>
            <p className="price">
              {plan.priceMinor === 0 ? (
                t("free")
              ) : (
                <>
                  ${(plan.priceMinor / 100).toFixed(0)}
                  <span>{t("perMonth")}</span>
                </>
              )}
            </p>
            <ul className="features">
              {plan.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
              <li>{t("quota", { count: plan.quotas.aiMessages })}</li>
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
