/**
 * Sent when a workspace offers a seat to an address.
 *
 * It links to the account page, not to an invite link, because there is no
 * invite link: the seat is held for the address, and signing in at it is the
 * accept. So the mail carries nothing worth keeping safe and nothing that
 * stops working if it is forwarded — forwarding it only sends somebody else to
 * a sign-in form that will mail them their own link, at an address no invite is
 * waiting for.
 *
 * The inviter's address is in the body rather than only in the From line. A
 * mail saying a stranger has been given a seat somewhere is the kind nobody
 * acts on, and the one name that makes it legible is the colleague who sent it.
 */
import { INVITE_TTL_DAYS } from "@/domain/invite";
import type { Locale } from "@/i18n";
import type { Copy } from "./copy";
import { EmailShell, emailFooter, emailHeading, emailParagraph } from "./layout";

export interface InviteEmailProps {
  locale: Locale;
  /** This notice's copy in that language, scoped by the renderer. */
  copy: Copy;
  tenantName: string;
  /** Who sent it, as the row recorded them. */
  inviterEmail: string;
  /** Where signing in lands, in the language this is written in. */
  accountUrl: string;
}

export function InviteEmail({
  locale,
  copy,
  tenantName,
  inviterEmail,
  accountUrl,
}: InviteEmailProps) {
  return (
    <EmailShell locale={locale} preview={copy("preview", { tenant: tenantName })}>
      <h1 style={emailHeading}>{copy("heading", { tenant: tenantName })}</h1>
      <p style={emailParagraph}>
        {copy("body", { tenant: tenantName, inviter: inviterEmail })}
      </p>
      <p style={emailParagraph}>{copy("cta")}</p>
      <p style={emailParagraph}>
        <a href={accountUrl}>{accountUrl}</a>
      </p>
      <p style={emailFooter}>{copy("footer", { days: INVITE_TTL_DAYS })}</p>
    </EmailShell>
  );
}
