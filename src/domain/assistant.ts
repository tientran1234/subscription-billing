/**
 * The assistant's provider-neutral contract.
 *
 * The same shape the gateway is behind, and for the same reason: the route
 * switches on THESE types, never on a model vendor's, so only
 * src/providers/anthropic.ts imports the model SDK and swapping that model —
 * or standing a second one up beside it — is one adapter and a line in the
 * factory.
 *
 * What the route needs back from a model call is not really the reply. It is
 * the answer to one question: was a message produced? The call has already
 * been counted by the time the model is asked, because the quota and the cap
 * in front of it are decided from that count and a counter read before its own
 * increment is a counter two concurrent calls can both pass. So the count has
 * to come first and be given back when nothing came of it — which is why an
 * adapter here reports a failure as an outcome instead of throwing one. A
 * thrown error is the one shape that walks straight past the line that gives
 * the unit back.
 */

export interface AssistantRequest {
  /** What the caller asked. The route validates it; adapters send it as-is. */
  prompt: string;
}

/**
 * Three outcomes, because the customer-facing answer distinguishes all three
 * while the billing rule below distinguishes only the first from the rest.
 */
export type AssistantReply =
  /** A message. The one outcome a month is billed for. */
  | { outcome: "answered"; text: string }
  /**
   * The model declined, or returned nothing there was anything to send back.
   * Named apart from the failure below because it is not one: the call reached
   * the model and the model answered by refusing, so there is nothing for the
   * caller to retry.
   */
  | { outcome: "declined"; category: string | null }
  /**
   * No answer to be had: a credential this deployment never set, a provider
   * having a bad minute, a request that ran out of time. Worth retrying, which
   * is the whole of why it is not folded into the decline above.
   */
  | { outcome: "unavailable" };

export interface IAssistantProvider {
  readonly name: string;
  /**
   * Ask the model.
   *
   * Never rejects: every way this can fail is one of the outcomes above. The
   * route has a unit to give back for each of them, and an adapter that threw
   * instead would be an adapter that bills for a message nobody received.
   */
  reply(input: AssistantRequest): Promise<AssistantReply>;
}

/**
 * Does this outcome bill the unit the route counted on the way in?
 *
 * One rule in one place: a unit is billed for a message produced and given
 * back when there was none. A decline costs us the tokens the model spent
 * deciding to decline, which is the right way round — a customer who asked for
 * something and received nothing has not spent a message out of their
 * allowance, and the alternative is a line on an invoice they cannot reconcile
 * against anything they were ever shown.
 */
export function billsAUnit(reply: AssistantReply): boolean {
  return reply.outcome === "answered";
}
