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
import { EmailShell, emailFooter, emailHeading, emailParagraph } from "./layout";

export const PAST_DUE_SUBJECT = "We could not take your payment";

export interface PastDueEmailProps {
  tenantName: string;
  planName: string;
  accountUrl: string;
}

export function PastDueEmail({ tenantName, planName, accountUrl }: PastDueEmailProps) {
  return (
    <EmailShell preview={`Update your card to keep ${planName}`}>
      <h1 style={emailHeading}>We could not take your payment</h1>
      <p style={emailParagraph}>
        Hi {tenantName}, the latest payment for your {planName} plan did not go through. Your
        card issuer usually gives no reason, and an expired card is the common one.
      </p>
      <p style={emailParagraph}>
        Nothing has been switched off. {planName} keeps working while we retry, so there is
        time to update the card:
      </p>
      <p style={emailParagraph}>
        <a href={accountUrl}>{accountUrl}</a>
      </p>
      <p style={emailFooter}>
        If you have already updated it, the next retry will settle and you can ignore this.
      </p>
    </EmailShell>
  );
}
