/**
 * In-memory assistant. Answers with no credential and no network, so the
 * end-to-end suite can drive the gates in front of a model call the way it
 * drives checkout against the in-memory gateway: there is no model account
 * behind CI, and the guarantees the suite checks are this application's rather
 * than the model's.
 *
 * Scripted where a test needs an outcome a model will not produce to order. The
 * unit given back for a call that produced no message is the part of this worth
 * checking, and it cannot be checked against a provider that always answers.
 */
import type { AssistantReply, AssistantRequest, IAssistantProvider } from "@/domain/assistant";

export class FakeAssistantProvider implements IAssistantProvider {
  readonly name = "fake";

  /** Every prompt this provider was asked, for a test to read back. */
  readonly prompts: string[] = [];

  constructor(private readonly scripted?: AssistantReply) {}

  async reply({ prompt }: AssistantRequest): Promise<AssistantReply> {
    this.prompts.push(prompt);
    return this.scripted ?? { outcome: "answered", text: `(fake) you asked: ${prompt}` };
  }
}
