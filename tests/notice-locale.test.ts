import { describe, expect, it } from "vitest";
import { noticeLocaleFor, noticePagesFor, preferredLocalesFor } from "@/domain/notice-locale";
import { defaultLocale, locales } from "@/i18n";

describe("which language a notice is written in", () => {
  it("writes in the language the workspace recorded", () => {
    for (const locale of locales) {
      expect(noticeLocaleFor(locale)).toBe(locale);
    }
  });

  it("falls back for a workspace that has never said", () => {
    // Every tenant from before the column carries null, and a notice that a
    // renewal failed still has to go out.
    expect(noticeLocaleFor(null)).toBe(defaultLocale);
    expect(noticeLocaleFor(undefined)).toBe(defaultLocale);
  });

  it("falls back for a language we do not publish, rather than refusing to send", () => {
    // A locale we have since dropped, or a column edited by hand. The wrong
    // language beats silence about a payment that failed.
    expect(noticeLocaleFor("de")).toBe(defaultLocale);
    expect(noticeLocaleFor("")).toBe(defaultLocale);
    expect(noticeLocaleFor("EN")).toBe(defaultLocale);
  });
});

describe("where a notice sends the reader", () => {
  it("prefixes both pages with the language the notice is written in", () => {
    const pages = noticePagesFor("https://billing.example.test", "vi");

    expect(pages.accountUrl).toBe("https://billing.example.test/vi/account");
    expect(pages.pricingUrl).toBe("https://billing.example.test/vi");
  });

  it("sends a reader of every language to their own pages", () => {
    // The prefix IS the guarantee: a mail written in one language that links
    // into another has given up the half the reader clicks.
    for (const locale of locales) {
      const pages = noticePagesFor("https://billing.example.test", locale);

      expect(pages.accountUrl).toContain(`/${locale}/`);
      expect(pages.pricingUrl.endsWith(`/${locale}`)).toBe(true);
    }
  });
});

describe("what the gateway is told a workspace reads", () => {
  it("sends the language the workspace picked, and only that one", () => {
    // One entry, not a chain. A gateway matches the list in order against the
    // languages it composes in, so a second entry would be this application
    // answering for a workspace that has already answered.
    for (const locale of locales) {
      expect(preferredLocalesFor(locale)).toEqual([locale]);
    }
  });

  it("gives the gateway a language it would compose a receipt in", () => {
    // The values cross into someone else's column, so they have to be the
    // plain tags a gateway understands rather than anything of our own.
    for (const locale of locales) {
      for (const tag of preferredLocalesFor(locale)) {
        expect(tag).toMatch(/^[a-z]{2}$/);
      }
    }
  });
});
