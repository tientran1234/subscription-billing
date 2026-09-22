import { getTranslations } from "next-intl/server";
import Link from "next/link";

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations("billing");
  return (
    <main>
      <h1>{t("cancelTitle")}</h1>
      <p className="sub">{t("cancelBody")}</p>
      <Link href={`/${locale}`}>{t("back")}</Link>
    </main>
  );
}
