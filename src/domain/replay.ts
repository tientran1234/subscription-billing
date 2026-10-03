/**
 * Who may replay which provider event.
 *
 * Pure — no I/O — like the rest of this directory, so the one rule that decides
 * a replay is written here rather than in whichever route happens to run it.
 *
 * A replay is for the delivery that never landed: an endpoint that was down for
 * an hour, a tunnel that was not running, an event the gateway stopped
 * retrying. Re-applying one is safe because the path it goes back through is
 * the webhook's own — the event id is still claimed in `WebhookEvent`, the
 * transition is still conditional — so what has to be decided here is not
 * whether the apply is idempotent but whose subscription is about to move.
 *
 * That is the whole danger of a replay. The event id arrives on a request, and
 * an id names something at the gateway rather than anything in this workspace:
 * an endpoint that applied whatever id it was handed would let any signed-in
 * person drive any tenant's state machine, which is a larger hole than the
 * missed webhook it was built to repair. So the event is tied back to a
 * subscription first, and that subscription has to be the caller's own.
 */

import type { BillingEvent } from "./billing-event";

export type ReplayRefusal =
  /** The gateway has no event under that id. */
  | "no_event"
  /** The event names no subscription here, so there is nothing to re-apply. */
  | "not_found"
  /** The event is about another workspace's subscription. */
  | "forbidden";

/** All the rule needs of the subscription the event was found by. */
export interface ReplaySubject {
  tenantId: string;
}

export type ReplayResolution =
  /** May be re-applied — as the event the gateway handed back, not as asked for. */
  | { ok: true; event: BillingEvent }
  | { ok: false; reason: ReplayRefusal };

/**
 * Whether `tenantId` may replay `event`, given the `subscription` it was found
 * by — `null` for either meaning the gateway or our own tables came up empty.
 *
 * The two refusals that both mean "not yours" are kept apart because the audit
 * row records which one happened, and whoever reads it later wants to know
 * whether the id was wrong or the workspace was. The route deliberately answers
 * them with one response; see src/app/api/replay/route.ts for why.
 */
export function checkReplay(
  tenantId: string,
  event: BillingEvent | null,
  subscription: ReplaySubject | null,
): ReplayResolution {
  if (!event) return { ok: false, reason: "no_event" };
  if (!subscription) return { ok: false, reason: "not_found" };
  if (subscription.tenantId !== tenantId) return { ok: false, reason: "forbidden" };
  return { ok: true, event };
}
