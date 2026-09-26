/**
 * Which dunning notice a subscription earns when its status moves.
 *
 * Pure, and separate from the sending, because the question "does this deserve
 * an email?" is a billing rule and not a mail concern. Only two statuses do:
 * a failed renewal, which the customer can still fix, and the end of the
 * subscription, which they cannot. Everything else — activation, renewal, a
 * plan that moved — is either good news nobody needs a mail about or a change
 * they made themselves a moment earlier.
 */

import type { SubscriptionStatus } from "./subscription";

export const DUNNING_KINDS = ["past_due", "goodbye"] as const;

export type DunningKind = (typeof DUNNING_KINDS)[number];

/**
 * `null` means silence. Note this maps the status ARRIVED AT, not the event:
 * a `payment_failed` that loses the conditional UPDATE never arrives anywhere,
 * and its caller is the one that knows that — see `notifyDunning`, which only
 * asks about a transition that actually happened.
 */
export function noticeForStatus(status: SubscriptionStatus): DunningKind | null {
  switch (status) {
    case "PAST_DUE":
      return "past_due";
    case "CANCELED":
      return "goodbye";
    default:
      return null;
  }
}
