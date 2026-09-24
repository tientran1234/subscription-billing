/**
 * Which provider customer the billing portal should open for.
 *
 * Pure, and separate from the state machine, because the answer is not "the
 * active subscription": a tenant whose plan lapsed still has a card to update
 * and an invoice history to read, and that is most of the reason they open the
 * portal at all. So this looks at every row the tenant has, whatever its
 * status, and picks the newest customer id among them.
 */

export interface PortalCandidate {
  /** Null until the first webhook for that subscription lands. */
  customerRef: string | null;
  createdAt: Date;
}

/**
 * `null` means there is nothing to manage yet — a tenant that has never
 * reached checkout, or whose only subscription is still PENDING because its
 * first webhook has not arrived. Callers turn that into "pick a plan first"
 * rather than opening an empty portal.
 */
export function portalCustomerFor(subscriptions: readonly PortalCandidate[]): string | null {
  let newest: PortalCandidate | null = null;
  for (const subscription of subscriptions) {
    if (!subscription.customerRef) continue;
    if (!newest || subscription.createdAt > newest.createdAt) newest = subscription;
  }
  return newest?.customerRef ?? null;
}
