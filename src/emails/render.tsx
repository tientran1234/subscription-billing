/**
 * A notice turned into the three things a mailer needs: subject, HTML, and a
 * plain-text part.
 *
 * Both parts come off the SAME React tree. A hand-written text alternative is
 * a second copy of the copy, and the one that goes stale is the one nobody
 * reads while testing.
 *
 * The language is an argument, not something looked up here. Which language a
 * workspace is written to in is a rule of its own (see
 * src/domain/notice-locale.ts) and the senders have already applied it; this
 * file's job is to pick the copy up in that language and make sure the subject
 * comes from the same section as the body, so a mail cannot go out with its
 * subject line in one language and its sentences in another.
 */
import { render } from "@react-email/render";
import type { ReactElement } from "react";
import type { CapWarningKind } from "@/domain/cap-warning";
import type { DunningKind } from "@/domain/dunning";
import type { Locale } from "@/i18n";
import { CapApproachingEmail, CapReachedEmail } from "./cap-warning";
import { emailCopy, type EmailSection } from "./copy";
import { GoodbyeEmail } from "./goodbye";
import { PastDueEmail } from "./past-due";

export interface DunningEmailProps {
  /** The language the workspace is written to in. */
  locale: Locale;
  tenantName: string;
  planName: string;
  /** Where a card is updated — the account page, not a portal link. */
  accountUrl: string;
  /** Where a cancelled tenant subscribes again. */
  pricingUrl: string;
}

export interface CapWarningEmailValues {
  /** The language the workspace is written to in. */
  locale: Locale;
  tenantName: string;
  planName: string;
  /** Units past the plan's quota so far this month. */
  units: number;
  /** The ceiling they were measured against. */
  cap: number;
  /** Where the ceiling is raised or removed. */
  accountUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const DUNNING_SECTIONS: Record<DunningKind, EmailSection> = {
  past_due: "pastDue",
  goodbye: "goodbye",
};

const CAP_WARNING_SECTIONS: Record<CapWarningKind, EmailSection> = {
  approaching: "capApproaching",
  reached: "capReached",
};

/**
 * The subject and both parts, off one section of copy.
 *
 * The subject is read from the same scoped lookup the tree was given, which is
 * the point of threading `copy` through rather than letting each template ask
 * for its own: there is one language and one section per notice, decided once.
 */
async function rendered(copy: ReturnType<typeof emailCopy>, element: ReactElement) {
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { subject: copy("subject"), html, text };
}

export async function renderDunningEmail(
  kind: DunningKind,
  props: DunningEmailProps,
): Promise<RenderedEmail> {
  const copy = emailCopy(props.locale, DUNNING_SECTIONS[kind]);
  const element =
    kind === "past_due" ? (
      <PastDueEmail copy={copy} {...props} />
    ) : (
      <GoodbyeEmail copy={copy} {...props} />
    );

  return rendered(copy, element);
}

/**
 * The same three for a spend-cap warning.
 *
 * A function of its own rather than a third branch of the one above: a dunning
 * notice is about a status the gateway moved and carries the plan it was moved
 * on, while this is about a counter of ours against a ceiling, and the figures
 * it needs are the ones a shared props type would have had to make optional for
 * both.
 */
export async function renderCapWarningEmail(
  kind: CapWarningKind,
  props: CapWarningEmailValues,
): Promise<RenderedEmail> {
  const copy = emailCopy(props.locale, CAP_WARNING_SECTIONS[kind]);
  const element =
    kind === "approaching" ? (
      <CapApproachingEmail copy={copy} {...props} />
    ) : (
      <CapReachedEmail copy={copy} {...props} />
    );

  return rendered(copy, element);
}
