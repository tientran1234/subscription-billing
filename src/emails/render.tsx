/**
 * A notice turned into the three things a mailer needs: subject, HTML, and a
 * plain-text part.
 *
 * Both parts come off the SAME React tree. A hand-written text alternative is
 * a second copy of the copy, and the one that goes stale is the one nobody
 * reads while testing.
 */
import { render } from "@react-email/render";
import type { CapWarningKind } from "@/domain/cap-warning";
import type { DunningKind } from "@/domain/dunning";
import {
  CAP_APPROACHING_SUBJECT,
  CAP_REACHED_SUBJECT,
  CapApproachingEmail,
  CapReachedEmail,
  type CapWarningEmailProps,
} from "./cap-warning";
import { GOODBYE_SUBJECT, GoodbyeEmail } from "./goodbye";
import { PAST_DUE_SUBJECT, PastDueEmail } from "./past-due";

export interface DunningEmailProps {
  tenantName: string;
  planName: string;
  /** Where a card is updated — the account page, not a portal link. */
  accountUrl: string;
  /** Where a cancelled tenant subscribes again. */
  pricingUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export async function renderDunningEmail(
  kind: DunningKind,
  props: DunningEmailProps,
): Promise<RenderedEmail> {
  const { subject, element } =
    kind === "past_due"
      ? { subject: PAST_DUE_SUBJECT, element: <PastDueEmail {...props} /> }
      : { subject: GOODBYE_SUBJECT, element: <GoodbyeEmail {...props} /> };

  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { subject, html, text };
}

/**
 * The same two parts for a spend-cap warning.
 *
 * A function of its own rather than a third branch of the one above: a dunning
 * notice is about a status the gateway moved and carries the plan it was moved
 * on, while this is about a counter of ours against a ceiling, and the figures
 * it needs are the ones a shared props type would have had to make optional for
 * both.
 */
export async function renderCapWarningEmail(
  kind: CapWarningKind,
  props: CapWarningEmailProps,
): Promise<RenderedEmail> {
  const { subject, element } =
    kind === "approaching"
      ? { subject: CAP_APPROACHING_SUBJECT, element: <CapApproachingEmail {...props} /> }
      : { subject: CAP_REACHED_SUBJECT, element: <CapReachedEmail {...props} /> };

  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { subject, html, text };
}
