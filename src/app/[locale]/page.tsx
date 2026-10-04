import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { currencyForLocale, formatMoney } from "@/domain/currency";
import { PLANS, priceMinorFor, type PlanKey } from "@/domain/entitlements";
import { locales } from "@/i18n";

export default async function PricingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("pricing");

  // One currency per locale: a Vietnamese price list in dollars is one nobody
  // can act on. The amount is the plan's own price in it rather than today's
  // conversion of the dollar one — see src/domain/currency.ts.
  const currency = currencyForLocale(locale);

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
        {(Object.keys(PLANS) as PlanKey[]).map((key) => {
          const plan = PLANS[key];
          const priceMinor = priceMinorFor(key, currency);
          return (
            <section key={key} className="plan">
              <h2 style={{ margin: "0 0 12px", fontSize: "1rem" }}>{plan.name}</h2>
              <p className="price">
                {priceMinor === 0 ? (
                  t("free")
                ) : (
                  <>
                    {formatMoney(priceMinor, currency, locale)}
                    <span>{t("perMonth")}</span>
                  </>
                )}
              </p>
              <ul className="features">
                {plan.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
                <li>{t("quota", { count: plan.quotas.aiMessages })}</li>
                {plan.trialDays > 0 && <li>{t("trial", { days: plan.trialDays })}</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}
