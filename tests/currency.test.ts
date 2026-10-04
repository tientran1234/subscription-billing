import { describe, expect, it } from "vitest";
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  checkCurrency,
  currencyForLocale,
  formatMoney,
  isCurrency,
} from "@/domain/currency";

/** What a customer actually reads, with the grouping and the symbol taken off. */
const digits = (formatted: string) => formatted.replace(/\D/g, "");

describe("currencies we sell in", () => {
  it("knows the ones with a price behind them, and nothing else", () => {
    for (const currency of CURRENCIES) expect(isCurrency(currency)).toBe(true);
    expect(isCurrency("gbp")).toBe(false);
    expect(isCurrency("USD")).toBe(false);
    expect(isCurrency(undefined)).toBe(false);
  });

  // The refusal is what keeps a checkout from opening a session nobody could
  // pay: no plan carries a price in a currency that is not on the list.
  it("refuses a currency no plan is priced in", () => {
    for (const currency of CURRENCIES) expect(checkCurrency(currency)).toBeNull();
    expect(checkCurrency("gbp")).toBe("unsupported_currency");
  });

  it("bills a checkout that names none in one we do sell", () => {
    expect(isCurrency(DEFAULT_CURRENCY)).toBe(true);
  });
});

describe("writing an amount out", () => {
  // The trap this exists for: the dong has no subdivision, so its minor unit
  // is the dong. Divide it by a hundred the way a cent needs and the customer
  // is quoted 4,900 ₫ for a plan that costs 490,000 ₫.
  it("does not divide a currency that has no minor unit", () => {
    expect(digits(formatMoney(490_000, "vnd", "vi"))).toBe("490000");
  });

  it("still writes the ones that do have one as a major amount", () => {
    expect(digits(formatMoney(1_900, "usd", "en"))).toBe("1900");
  });

  // A quote comes back from the gateway, so the currency on it is a string
  // rather than one of ours. Showing it as if it had cents is the least
  // surprising way to render an amount we should never have been handed.
  it("falls back to two decimals for a currency we do not sell", () => {
    expect(digits(formatMoney(1_900, "gbp", "en"))).toBe("1900");
  });
});

describe("the currency a locale is quoted in", () => {
  it("prices Vietnamese pages in dong and everything else in the default", () => {
    expect(currencyForLocale("vi")).toBe("vnd");
    expect(currencyForLocale("en")).toBe(DEFAULT_CURRENCY);
    expect(currencyForLocale("de")).toBe(DEFAULT_CURRENCY);
  });
});
