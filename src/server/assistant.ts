/**
 * Asking the model, through whichever adapter this deployment is wired to.
 *
 * One line of its own because building the adapter can fail where calling it
 * cannot: a deployment that has never set a model credential throws out of the
 * factory, and that is the same news as a provider having a bad minute — no
 * message was produced. Caught here rather than in the route so the route has
 * one shape to handle, and so the unit it has already counted goes back in
 * both cases instead of only the one the port promises not to throw for.
 */
import type { AssistantReply, AssistantRequest } from "@/domain/assistant";
import { assistantProvider } from "@/providers";

export async function askAssistant(input: AssistantRequest): Promise<AssistantReply> {
  try {
    return await assistantProvider().reply(input);
  } catch {
    return { outcome: "unavailable" };
  }
}
