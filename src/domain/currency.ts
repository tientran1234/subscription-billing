/**
 * The currencies a subscription may be bought in, and what an amount in one
 * means.
 *
 * Pure — no I/O — like the rest of this directory, so the one answer about
 * money runs on the pricing page, at checkout and in the quote a plan change
 * puts in front of a customer, rather than being written three times.
 *
 * Two facts live here, and both go wrong quietly. A minor unit is not a
 * hundredth of anything in particular: the dong has no subdivision, so its
 * minor unit is the dong itself, and the division by a hundred that every
 * other amount here needs would quote a Vietnamese customer a price a hundred
 * times too small. And a currency is chosen once, at checkout: the gateway
 * fixes it when the subscription is created and will not move a live one, so
 * everything after that reads it off the subscription instead of asking again.
 */

export const CURRENCIES = ["usd", "vnd"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** What a checkout that names no currency is billed in. */
export const DEFAULT_CURRENCY: Currency = "usd";

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

export type CurrencyRefusal =
  /** Not one of the currencies our plans carry a price in. */
  "unsupported_currency";

/**
 * Whether a subscription may be bought in `currency`. `null` means it may.
 *
 * Shaped like {@link import("./seats").checkSeats} so the routes refuse both
 * the same way: a currency with no price behind it is a session nobody could
 * pay, and it is refused before a row is written rather than after the gateway
 * has opened one.
 */
export function checkCurrency(currency: string): CurrencyRefusal | null {
  return isCurrency(currency) ? null : "unsupported_currency";
}

/** Minor units in one unit of the currency. The dong has no smaller one. */
const MINOR_UNITS: Record<Currency, number> = { usd: 100, vnd: 1 };

export function minorUnitsIn(currency: string): number {
  // Two decimals for a currency we do not sell: a gateway quoting one at us is
  // already wrong, and most of the world's currencies subdivide that way, so it
  // is the least surprising way to show an amount we should never have been
  // handed.
  return isCurrency(currency) ? MINOR_UNITS[currency] : 100;
}

/** An amount in minor units, written the way a customer in `locale` reads it. */
export function formatMoney(minorAmount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(minorAmount / minorUnitsIn(currency));
}

/**
 * Prices in one locale are quoted in one currency, because a price list a
 * customer cannot act on is worse than one in a second language. It is only
 * the default: what a subscription is billed in is what the checkout asked
 * for, and that is what gets recorded.
 */
const CURRENCY_BY_LOCALE: Record<string, Currency> = { vi: "vnd" };

export function currencyForLocale(locale: string): Currency {
  return CURRENCY_BY_LOCALE[locale] ?? DEFAULT_CURRENCY;
}
