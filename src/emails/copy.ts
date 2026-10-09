/**
 * The words a notice is written from, in the language the workspace reads.
 *
 * Off the same message files the pages use, through next-intl's request-free
 * translator rather than the hooks the pages get. A notice is composed by a
 * webhook or by a metered request: there is no locale in the URL, no provider
 * above it and no request whose language could be negotiated, so the locale is
 * handed in and the messages are read straight off the import. One set of
 * message files all the same — copy kept in a second place is copy that goes
 * stale in one of them.
 */
import { createTranslator } from "next-intl";
import type { Locale } from "@/i18n";
import en from "@/i18n/messages/en.json";
import vi from "@/i18n/messages/vi.json";

/**
 * Written out rather than imported by a computed path, so a locale added to
 * src/i18n.ts without the messages to go with it is a compile error here
 * instead of a mail that arrives with its placeholders showing. The shared
 * `typeof en` is what makes the two files have to agree key for key.
 */
const MESSAGES: Record<Locale, typeof en> = { en, vi };

/** The notices that have copy of their own, as named under `emails`. */
export const EMAIL_SECTIONS = ["pastDue", "goodbye", "capApproaching", "capReached"] as const;
export type EmailSection = (typeof EMAIL_SECTIONS)[number];

/**
 * A lookup into one notice's copy: `copy("heading")`, `copy("body", values)`.
 *
 * Narrower than what next-intl hands back — no `rich`, no markup — because a
 * mail's copy is text that goes into both the HTML and the plain-text part, and
 * anything that could only survive one of them does not belong in it.
 */
export type Copy = (key: string, values?: Record<string, string | number>) => string;

/** The copy for one notice, scoped so a template asks for `heading`, not a path. */
export function emailCopy(locale: Locale, section: EmailSection): Copy {
  return createTranslator({
    locale,
    messages: MESSAGES[locale],
    namespace: `emails.${section}`,
  });
}
