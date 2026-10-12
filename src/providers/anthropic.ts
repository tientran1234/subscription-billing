/**
 * The model, behind the same kind of adapter the gateway is behind.
 *
 * This is the only file allowed to import the model SDK, the way
 * src/providers/stripe.ts is the only file allowed to import `stripe`. What
 * reaches the route is src/domain/assistant.ts's outcomes, so swapping this
 * model out — or standing a second one up beside it — is one adapter and a
 * line in the factory.
 *
 * The mapping is exported on its own, as the gateway adapter's `normalize` is,
 * because it is the part with decisions in it: a test can hand it the replies a
 * model will not produce to order, and those are precisely the replies that
 * decide whether a customer is billed.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AssistantReply, AssistantRequest, IAssistantProvider } from "@/domain/assistant";

/**
 * The model this application calls, named once here for the same reason the
 * plan catalogue is named once in src/domain/entitlements.ts: a deployment
 * that could choose its own would be a deployment whose bills and whose
 * answers nobody here can account for.
 */
const MODEL = "claude-opus-5-5";

/**
 * Enough room for a long answer and not for a runaway one. The quota counts
 * messages rather than tokens, so the length of a reply changes what we pay
 * and never what the customer is billed — which makes this a latency setting,
 * and the system prompt below already asks for a short answer.
 */
const MAX_TOKENS = 4_096;

/**
 * Thinking cannot be turned off on this model, so depth is set by effort, and
 * a question typed at a billing assistant is answered at the bottom of that
 * range: the default is a level higher and would spend tokens and seconds on
 * reasoning this route has no use for.
 */
const EFFORT = "low" as const;

/**
 * A request this long has either been answered or is not going to be. The
 * SDK's own retries multiply it, so the ceiling is this times the attempts —
 * kept to one retry because the caller is holding an HTTP request open and a
 * unit of their allowance is counted against it until we answer.
 */
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

/**
 * Deliberately plain. The gates in front of this call are what this route is,
 * and a prompt worth tuning belongs to whatever product is being sold on top
 * of it rather than to the billing slice underneath.
 */
const SYSTEM =
  "You are the assistant in a subscription billing application. " +
  "Answer the question you are asked, directly and briefly.";

/** The part of a model reply this application reads. */
type ModelReply = Pick<
  Anthropic.Beta.Messages.BetaMessage,
  "content" | "stop_reason" | "stop_details"
>;

/**
 * A model reply, as one of the outcomes the route bills from.
 *
 * Two things here are easy to leave out and both bill a customer for nothing.
 * A refusal arrives as a perfectly successful response whose content carries
 * no answer, so the stop reason has to be read before the content is. And a
 * response that carries no text block at all — thinking and nothing else — is
 * not a message either, whatever the stop reason says about it.
 */
export function replyFrom(message: ModelReply): AssistantReply {
  if (message.stop_reason === "refusal") {
    return { outcome: "declined", category: message.stop_details?.category ?? null };
  }

  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();

  return text ? { outcome: "answered", text } : { outcome: "declined", category: null };
}

export class AnthropicProvider implements IAssistantProvider {
  readonly name = "anthropic";

  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES });
  }

  async reply({ prompt }: AssistantRequest): Promise<AssistantReply> {
    try {
      const message = await this.client.beta.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        output_config: { effort: EFFORT },
        // A refusal otherwise ends the call with nothing to send back. This
        // asks the provider to put the same request to its own substitute
        // model before giving up, so a question this one declines on policy
        // grounds can still be answered within the one call we are billing a
        // unit for.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      });

      return replyFrom(message);
    } catch {
      // Every failure is the same outcome, because the only thing the route
      // does about it is the same: no message was produced, so the unit goes
      // back. The distinction worth keeping would be retryable against not,
      // and the SDK has already spent its retries by the time we are here.
      return { outcome: "unavailable" };
    }
  }
}
