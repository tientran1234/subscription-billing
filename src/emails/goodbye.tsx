/**
 * Sent when a subscription reaches CANCELED — from the portal, or because the
 * retries on a failed renewal ran out.
 *
 * Paid access is already gone by the time this sends: entitlements are derived
 * on read, so the drop to Free happened on the request after the webhook. The
 * mail says so rather than implying a grace period that does not exist.
 */
import { EmailShell, emailFooter, emailHeading, emailParagraph } from "./layout";

export const GOODBYE_SUBJECT = "Your subscription has ended";

export interface GoodbyeEmailProps {
  tenantName: string;
  planName: string;
  pricingUrl: string;
}

export function GoodbyeEmail({ tenantName, planName, pricingUrl }: GoodbyeEmailProps) {
  return (
    <EmailShell preview={`Your ${planName} plan has ended`}>
      <h1 style={emailHeading}>Your subscription has ended</h1>
      <p style={emailParagraph}>
        Hi {tenantName}, your {planName} plan has ended and you will not be billed for it
        again. Your account is still here, now on the Free plan.
      </p>
      <p style={emailParagraph}>Whenever you want {planName} back, it starts again here:</p>
      <p style={emailParagraph}>
        <a href={pricingUrl}>{pricingUrl}</a>
      </p>
      <p style={emailFooter}>Thanks for the time you spent with us.</p>
    </EmailShell>
  );
}
