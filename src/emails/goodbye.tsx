/**
 * Sent when a subscription reaches CANCELED — from the portal, or because the
 * retries on a failed renewal ran out.
 *
 * Paid access is already gone by the time this sends: entitlements are derived
 * on read, so the drop to Free happened on the request after the webhook. The
 * mail says so rather than implying a grace period that does not exist.
 */
import type { Locale } from "@/i18n";
import type { Copy } from "./copy";
import { EmailShell, emailFooter, emailHeading, emailParagraph } from "./layout";

export interface GoodbyeEmailProps {
  locale: Locale;
  /** This notice's copy in that language, scoped by the renderer. */
  copy: Copy;
  tenantName: string;
  planName: string;
  pricingUrl: string;
}

export function GoodbyeEmail({
  locale,
  copy,
  tenantName,
  planName,
  pricingUrl,
}: GoodbyeEmailProps) {
  return (
    <EmailShell locale={locale} preview={copy("preview", { plan: planName })}>
      <h1 style={emailHeading}>{copy("heading")}</h1>
      <p style={emailParagraph}>{copy("body", { tenant: tenantName, plan: planName })}</p>
      <p style={emailParagraph}>{copy("cta", { plan: planName })}</p>
      <p style={emailParagraph}>
        <a href={pricingUrl}>{pricingUrl}</a>
      </p>
      <p style={emailFooter}>{copy("footer")}</p>
    </EmailShell>
  );
}
