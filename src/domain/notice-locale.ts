/**
 * Which language a notice to a workspace is written in, and where it sends the
 * reader.
 *
 * Pure — no I/O — like the rest of this directory, so the dunning hook and the
 * cap warning write in one language rather than each deciding for itself what a
 * stored locale means.
 *
 * A notice is the one thing here that is read away from the app. The pages take
 * their locale from the URL they were fetched with, and next-intl negotiates
 * that against the browser; a mail has neither. It is composed by a webhook
 * Stripe sent or by the request that ran a workspace into its cap — contexts
 * with no reader attached and nothing to ask — so the workspace's own recorded
 * answer is all there is to go on. That is why the language is a column and not
 * something worked out at send time.
 */
import { defaultLocale, isLocale, type Locale } from "@/i18n";

/**
 * The language to write to a workspace in, given what it has recorded.
 *
 * Null reads as the default without being the same thing as it: a workspace
 * that has never said is not a workspace that chose English, and keeping the
 * two apart is what lets a second default be argued about later without
 * overruling the rows that asked for the first one.
 *
 * A locale we do not publish reads the same way — one we have since dropped, or
 * a column edited by hand. A notice that a renewal failed is worth more in the
 * wrong language than not at all, so the unknown value falls back rather than
 * stopping the send.
 */
export function noticeLocaleFor(stored: string | null | undefined): Locale {
  return isLocale(stored) ? stored : defaultLocale;
}

/**
 * The pages a notice links to, in the language it is written in.
 *
 * Here rather than in each sender because the prefix IS the guarantee: a mail
 * written in Vietnamese that links to `/en/account` has given up half of what
 * the language was recorded for, and that is the half the reader clicks. Both
 * senders ask one function so neither can be the one that forgets.
 */
export interface NoticePages {
  /** Where a card is updated and a cap is moved. */
  accountUrl: string;
  /** Where a cancelled workspace subscribes again. */
  pricingUrl: string;
}

export function noticePagesFor(appUrl: string, locale: Locale): NoticePages {
  return { accountUrl: `${appUrl}/${locale}/account`, pricingUrl: `${appUrl}/${locale}` };
}
