import { describe, expect, it } from "vitest";
import { INVITE_TTL_DAYS } from "@/domain/invite";
import { renderInviteEmail } from "@/emails/render";

const props = {
  locale: "en" as const,
  tenantName: "Acme",
  inviterEmail: "owner@acme.test",
  accountUrl: "https://billing.example.test/en/account",
};

const vi = {
  locale: "vi" as const,
  tenantName: "Acme",
  inviterEmail: "owner@acme.test",
  accountUrl: "https://billing.example.test/vi/account",
};

describe("the invite mail", () => {
  it("names the colleague who sent it, not just the workspace", async () => {
    // A mail saying a stranger has been given a seat somewhere is the kind
    // nobody acts on. The inviter is the one name that makes it legible.
    const mail = await renderInviteEmail(props);

    expect(mail.subject).toContain("owner@acme.test");
    expect(mail.html).toContain("owner@acme.test");
    expect(mail.html).toContain("Acme");
  });

  it("carries no invite link — only the page a sign-in lands on", async () => {
    // This is the guarantee the whole design rests on: the seat is held for
    // the address, so there is no token in the mail to forward, expire or
    // leak. Anything that looked like one would be a second credential.
    const mail = await renderInviteEmail(props);

    expect(mail.html).toContain("https://billing.example.test/en/account");
    expect(mail.html).not.toMatch(/token|invite\/[A-Za-z0-9]/);
  });

  it("says how long the seat is held for, off the one constant that decides", async () => {
    const mail = await renderInviteEmail(props);
    expect(mail.text).toContain(String(INVITE_TTL_DAYS));
  });

  it("renders a plain-text part from the same tree, so the two cannot drift", async () => {
    const mail = await renderInviteEmail(props);

    expect(mail.text).toContain("Acme");
    expect(mail.text).toContain("https://billing.example.test/en/account");
    expect(mail.text).not.toContain("<p");
  });

  it("writes to a Vietnamese workspace in Vietnamese, subject included", async () => {
    // The workspace's language, which is all there is to go on: the invited
    // address has no row here yet.
    const mail = await renderInviteEmail(vi);
    const english = await renderInviteEmail(props);

    expect(mail.subject).not.toBe(english.subject);
    expect(mail.subject).toContain("đã mời bạn");
    expect(mail.html).toContain('lang="vi"');
  });

  it("links a reader into the pages of the language they are written in", async () => {
    const mail = await renderInviteEmail(vi);

    expect(mail.html).toContain("https://billing.example.test/vi/account");
    expect(mail.html).not.toContain("/en/");
  });
});
