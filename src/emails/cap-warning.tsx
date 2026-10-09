/**
 * Sent when a month's overage approaches the ceiling the workspace set, and
 * again if it reaches it.
 *
 * Both link to the account page, where the cap is raised or removed — not to
 * the provider's portal, which has never been told about the cap and could not
 * change it. Unlike a dunning notice there is nothing here to pay: the
 * customer is inside an agreement they wrote themselves, and the mail is about
 * where they put the edge of it.
 *
 * Each says the two figures the decision needs — how far past the allowance the
 * month has run, and where the ceiling is — because a warning that says only
 * "nearly" leaves the reader to go and look up the number it was talking about.
 */
import type { Locale } from "@/i18n";
import type { Copy } from "./copy";
import { EmailShell, emailFooter, emailHeading, emailParagraph } from "./layout";

export interface CapWarningEmailProps {
  locale: Locale;
  /** This notice's copy in that language, scoped by the renderer. */
  copy: Copy;
  tenantName: string;
  planName: string;
  /** Units past the plan's quota so far this month. */
  units: number;
  /** The ceiling they were measured against. */
  cap: number;
  /** Where the ceiling is raised or removed. */
  accountUrl: string;
}

export function CapApproachingEmail({
  locale,
  copy,
  tenantName,
  planName,
  units,
  cap,
  accountUrl,
}: CapWarningEmailProps) {
  return (
    <EmailShell locale={locale} preview={copy("preview", { units, cap })}>
      <h1 style={emailHeading}>{copy("heading")}</h1>
      <p style={emailParagraph}>
        {copy("body", { tenant: tenantName, plan: planName, units, cap })}
      </p>
      <p style={emailParagraph}>{copy("cta", { cap })}</p>
      <p style={emailParagraph}>
        <a href={accountUrl}>{accountUrl}</a>
      </p>
      <p style={emailFooter}>{copy("footer")}</p>
    </EmailShell>
  );
}

/**
 * Deliberately says the cap and not the counter. By the time this sends, the
 * counter is a unit or two above the ceiling — the call is metered before it is
 * refused, which is what lets the next cap check see it — and only the cap will
 * ever be billed, so quoting the larger figure would invite a question about a
 * number that appears on no invoice. That is why `units` reaches the copy of
 * the warning above and not this one.
 */
export function CapReachedEmail({
  locale,
  copy,
  tenantName,
  planName,
  cap,
  accountUrl,
}: CapWarningEmailProps) {
  return (
    <EmailShell locale={locale} preview={copy("preview", { plan: planName })}>
      <h1 style={emailHeading}>{copy("heading")}</h1>
      <p style={emailParagraph}>{copy("body", { tenant: tenantName, plan: planName, cap })}</p>
      <p style={emailParagraph}>{copy("cta", { plan: planName })}</p>
      <p style={emailParagraph}>
        <a href={accountUrl}>{accountUrl}</a>
      </p>
      <p style={emailFooter}>{copy("footer", { cap })}</p>
    </EmailShell>
  );
}
