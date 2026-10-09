/**
 * Sent when a renewal fails and the subscription enters PAST_DUE.
 *
 * It links to the account page rather than to the provider's billing portal,
 * even though the portal is where the card is actually replaced: portal links
 * are single-use and expire in minutes, so one minted at send time would be
 * dead by the time anyone read the mail. The account page mints a fresh one on
 * the click.
 *
 * The tone assumes nothing is lost yet, because nothing is — PAST_DUE keeps
 * paid access on purpose (see `entitlementsFor`).
 */
import type { Locale } from "@/i18n";
import type { Copy } from "./copy";
import { EmailShell, emailFooter, emailHeading, emailParagraph } from "./layout";

export interface PastDueEmailProps {
  locale: Locale;
  /** This notice's copy in that language, scoped by the renderer. */
  copy: Copy;
  tenantName: string;
  planName: string;
  accountUrl: string;
}

export function PastDueEmail({
  locale,
  copy,
  tenantName,
  planName,
  accountUrl,
}: PastDueEmailProps) {
  return (
    <EmailShell locale={locale} preview={copy("preview", { plan: planName })}>
      <h1 style={emailHeading}>{copy("heading")}</h1>
      <p style={emailParagraph}>{copy("body", { tenant: tenantName, plan: planName })}</p>
      <p style={emailParagraph}>{copy("cta", { plan: planName })}</p>
      <p style={emailParagraph}>
        <a href={accountUrl}>{accountUrl}</a>
      </p>
      <p style={emailFooter}>{copy("footer")}</p>
    </EmailShell>
  );
}
