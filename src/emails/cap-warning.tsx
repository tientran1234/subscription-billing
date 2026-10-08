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
import { EmailShell, emailFooter, emailHeading, emailParagraph } from "./layout";

export const CAP_APPROACHING_SUBJECT = "You are close to your spend cap";

export const CAP_REACHED_SUBJECT = "Your spend cap has paused further usage";

export interface CapWarningEmailProps {
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
  tenantName,
  planName,
  units,
  cap,
  accountUrl,
}: CapWarningEmailProps) {
  return (
    <EmailShell preview={`${units} of your ${cap} extra messages are gone`}>
      <h1 style={emailHeading}>You are close to your spend cap</h1>
      <p style={emailParagraph}>
        Hi {tenantName}, this month has used {units} of the {cap} messages past your{" "}
        {planName} allowance that you agreed to be billed for.
      </p>
      <p style={emailParagraph}>
        Nothing has stopped. When the {cap} are gone, further calls are refused until the
        allowance resets at the start of next month — so if this month needs more than that,
        the ceiling is yours to raise:
      </p>
      <p style={emailParagraph}>
        <a href={accountUrl}>{accountUrl}</a>
      </p>
      <p style={emailFooter}>
        You will not be billed past the cap, whether or not you move it.
      </p>
    </EmailShell>
  );
}

/**
 * Deliberately says the cap and not the counter. By the time this sends, the
 * counter is a unit or two above the ceiling — the call is metered before it is
 * refused, which is what lets the next cap check see it — and only the cap will
 * ever be billed, so quoting the larger figure would invite a question about a
 * number that appears on no invoice.
 */
export function CapReachedEmail({
  tenantName,
  planName,
  cap,
  accountUrl,
}: CapWarningEmailProps) {
  return (
    <EmailShell preview={`Calls past your ${planName} allowance are being refused`}>
      <h1 style={emailHeading}>Your spend cap has paused further usage</h1>
      <p style={emailParagraph}>
        Hi {tenantName}, this month has reached the cap of {cap} messages past your{" "}
        {planName} allowance, and calls beyond it are now being refused.
      </p>
      <p style={emailParagraph}>
        Everything inside the {planName} plan itself goes on working. To carry on past the
        allowance this month, raise the ceiling here:
      </p>
      <p style={emailParagraph}>
        <a href={accountUrl}>{accountUrl}</a>
      </p>
      <p style={emailFooter}>
        Or leave it where it is: the allowance resets at the start of next month, and you
        will be billed for {cap} and no more.
      </p>
    </EmailShell>
  );
}
