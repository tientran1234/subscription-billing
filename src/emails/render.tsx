/**
 * A dunning kind turned into the three things a mailer needs: subject, HTML,
 * and a plain-text part.
 *
 * Both parts come off the SAME React tree. A hand-written text alternative is
 * a second copy of the copy, and the one that goes stale is the one nobody
 * reads while testing.
 */
import { render } from "@react-email/render";
import type { DunningKind } from "@/domain/dunning";
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
