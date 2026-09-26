import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_STATUSES } from "@/domain/subscription";
import { noticeForStatus } from "@/domain/dunning";
import { renderDunningEmail } from "@/emails/render";

const props = {
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
    // and EXPIRED is a checkout that was abandoned — nobody to write to.
    const quiet = SUBSCRIPTION_STATUSES.filter((s) => noticeForStatus(s) === null);
    expect(quiet).toEqual(["PENDING", "ACTIVE", "EXPIRED"]);
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
