import { getRequestConfig } from "next-intl/server";

export const locales = ["en", "vi"] as const;
export const defaultLocale = "en";
export type Locale = (typeof locales)[number];

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = isLocale(requested) ? requested : defaultLocale;
  return {
    locale,
    messages: (await import(`./i18n/messages/${locale}.json`)).default,
  };
});
