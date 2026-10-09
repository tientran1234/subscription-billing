import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_STATUSES } from "@/domain/subscription";
import { noticeForStatus } from "@/domain/dunning";
import { renderDunningEmail } from "@/emails/render";

const props = {
  locale: "en" as const,
  tenantName: "Acme",
  planName: "Pro",
  accountUrl: "https://billing.example.test/en/account",
  pricingUrl: "https://billing.example.test/en",
};

describe("which status earns a notice", () => {
  it("writes to a customer whose renewal failed and to one who has left", () => {
    expect(noticeForStatus("PAST_DUE")).toBe("past_due");
    expect(noticeForStatus("CANCELED")).toBe("goodbye");
  });

  it("stays quiet about every other status", () => {
    // Activation and renewal are not news the customer needs mailing about,
    // EXPIRED is a checkout that was abandoned — nobody to write to — and a
    // trial starting is something the customer did a moment earlier.
    const quiet = SUBSCRIPTION_STATUSES.filter((s) => noticeForStatus(s) === null);
    expect(quiet).toEqual(["PENDING", "TRIALING", "ACTIVE", "EXPIRED"]);
  });
});

describe("dunning templates", () => {
  it("points a past-due customer at the account page, not at a portal link", async () => {
    // Portal links are single-use and expire in minutes; one minted at send
    // time would be dead before the mail was opened.
    const mail = await renderDunningEmail("past_due", props);

    expect(mail.subject).toBe("We could not take your payment");
    expect(mail.html).toContain(props.accountUrl);
    expect(mail.html).toContain("Acme");
    expect(mail.html).toContain("Pro");
    expect(mail.html).not.toContain("portal");
  });

  it("does not tell a past-due customer they have lost access, because they have not", async () => {
    const mail = await renderDunningEmail("past_due", props);
    expect(mail.text).toContain("Nothing has been switched off");
  });

  it("tells a cancelled customer where to start again", async () => {
    const mail = await renderDunningEmail("goodbye", props);

    expect(mail.subject).toBe("Your subscription has ended");
    expect(mail.html).toContain(props.pricingUrl);
    expect(mail.html).toContain("Free plan");
  });

  it("renders a plain-text part from the same tree, so the two cannot drift", async () => {
    for (const kind of ["past_due", "goodbye"] as const) {
      const mail = await renderDunningEmail(kind, props);
      const link = kind === "past_due" ? props.accountUrl : props.pricingUrl;

      expect(mail.text).toContain(link);
      expect(mail.text).toContain("Acme");
      expect(mail.text).not.toContain("<p");
    }
  });

  it("keeps the preheader out of the plain-text part", async () => {
    // It is there to fill the inbox preview line; repeated as the first line
    // of the text part it just reads as a stutter.
    const mail = await renderDunningEmail("goodbye", props);

    expect(mail.html).toContain("Your Pro plan has ended");
    expect(mail.text).not.toContain("Your Pro plan has ended");
  });
});

describe("the language a notice is written in", () => {
  // The guarantee the item exists for. Asserted on the copy and not on a
  // locale argument coming back out, because what a reader gets is the
  // sentences: a template that took the language and ignored it would pass a
  // test that only checked what it was handed.
  const vi = {
    locale: "vi" as const,
    tenantName: "Acme",
    planName: "Pro",
    accountUrl: "https://billing.example.test/vi/account",
    pricingUrl: "https://billing.example.test/vi",
  };

  it("writes to a Vietnamese workspace in Vietnamese", async () => {
    const mail = await renderDunningEmail("past_due", vi);

    expect(mail.subject).toBe("Chúng tôi chưa thu được khoản thanh toán của bạn");
    expect(mail.html).toContain("Ngân hàng phát hành thẻ");
    expect(mail.text).toContain("Chưa có gì bị tắt");
  });

  it("keeps the subject in the same language as the body", async () => {
    // One section of copy per notice, so a subject line cannot come from the
    // default while the sentences under it come from somewhere else.
    for (const kind of ["past_due", "goodbye"] as const) {
      const [english, vietnamese] = await Promise.all([
        renderDunningEmail(kind, props),
        renderDunningEmail(kind, vi),
      ]);

      expect(vietnamese.subject).not.toBe(english.subject);
      expect(vietnamese.html).not.toBe(english.html);
    }
  });

  it("marks the language on the document, so a reader is read to in it", async () => {
    const mail = await renderDunningEmail("goodbye", vi);
    expect(mail.html).toContain('lang="vi"');
  });

  it("links a reader into the pages of the language they are written in", async () => {
    const mail = await renderDunningEmail("goodbye", vi);

    expect(mail.html).toContain("https://billing.example.test/vi");
    expect(mail.html).not.toContain("/en/");
  });
});
