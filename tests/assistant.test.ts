/**
 * What a model call owes the counter in front of it, and what an adapter owes
 * the route.
 *
 * The rule is pure and lives in the domain so the route, this test and
 * anything later that asks a model behind the same gates read one answer: the
 * unit is billed for a message and given back when there was none.
 */
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { billsAUnit, type AssistantReply, type IAssistantProvider } from "@/domain/assistant";
import { FakeAssistantProvider } from "@/providers/fake-assistant";
import { replyFrom } from "@/providers/anthropic";

describe("what a reply bills", () => {
  it("bills the unit for a message", () => {
    expect(billsAUnit({ outcome: "answered", text: "hello" })).toBe(true);
  });

  // Both of these would otherwise have a customer paying for a message that
  // was never delivered to them.
  it("bills nothing for a decline", () => {
    expect(billsAUnit({ outcome: "declined", category: "cyber" })).toBe(false);
  });

  it("bills nothing for a provider that could not answer", () => {
    expect(billsAUnit({ outcome: "unavailable" })).toBe(false);
  });

  // An empty answer is still an answer: the model produced a message, and
  // whether it was a good one is not a billing question.
  it("bills the unit for a message with nothing much in it", () => {
    expect(billsAUnit({ outcome: "answered", text: "" })).toBe(true);
  });
});

/**
 * Every assistant adapter passes this unchanged, the way every gateway adapter
 * passes tests/provider-conformance.test.ts. The contract is one sentence —
 * report, do not throw — and it is the sentence the refund depends on.
 */
function contract(name: string, make: (scripted?: AssistantReply) => IAssistantProvider) {
  describe(name, () => {
    it("answers a prompt with a message", async () => {
      const reply = await make().reply({ prompt: "what is my plan?" });
      expect(reply.outcome).toBe("answered");
    });

    it("reports a failure instead of rejecting", async () => {
      for (const scripted of [
        { outcome: "unavailable" },
        { outcome: "declined", category: null },
      ] satisfies AssistantReply[]) {
        await expect(make(scripted).reply({ prompt: "hello" })).resolves.toMatchObject({
          outcome: scripted.outcome,
        });
      }
    });

    it("says which adapter it is", () => {
      expect(make().name).toBeTruthy();
    });
  });
}

contract("fake assistant", (scripted) => new FakeAssistantProvider(scripted));

describe("fake assistant", () => {
  it("records what it was asked, so a test can read it back", async () => {
    const provider = new FakeAssistantProvider();
    await provider.reply({ prompt: "first" });
    await provider.reply({ prompt: "second" });
    expect(provider.prompts).toEqual(["first", "second"]);
  });

  it("answers deterministically, so a suite can assert on the reply", async () => {
    const reply = await new FakeAssistantProvider().reply({ prompt: "hello" });
    expect(reply).toEqual({ outcome: "answered", text: "(fake) you asked: hello" });
  });
});

/**
 * The model's replies, mapped. Hand-built rather than recorded, because the
 * two that decide whether a customer is billed are the two a model will not
 * produce on request: a refusal, and a response carrying no answer at all.
 */
const text = (value: string): Anthropic.Beta.Messages.BetaContentBlock => ({
  type: "text",
  text: value,
  citations: null,
});

const thinking = (): Anthropic.Beta.Messages.BetaContentBlock => ({
  type: "thinking",
  thinking: "",
  signature: "sig",
});

/** A refusal's details. Only the category is read; the rest is the SDK's shape. */
const refusal = (
  category: Anthropic.Beta.Messages.BetaRefusalStopDetails["category"],
): Anthropic.Beta.Messages.BetaRefusalStopDetails => ({
  type: "refusal",
  category,
  explanation: null,
  fallback_credit_token: null,
  fallback_has_prefill_claim: null,
  recommended_model: null,
});

describe("mapping a model reply", () => {
  it("reads a message off the text blocks", () => {
    expect(
      replyFrom({ content: [text("you are on Pro.")], stop_reason: "end_turn", stop_details: null }),
    ).toEqual({ outcome: "answered", text: "you are on Pro." });
  });

  it("joins a message that came back in pieces", () => {
    expect(
      replyFrom({
        content: [text("you are on "), text("Pro.")],
        stop_reason: "end_turn",
        stop_details: null,
      }),
    ).toEqual({ outcome: "answered", text: "you are on Pro." });
  });

  // Thinking is on by default on this model and its text is empty unless asked
  // for. Counting a block that is not an answer as one would bill the customer
  // for a reply that renders as nothing.
  it("ignores everything that is not a text block", () => {
    expect(
      replyFrom({
        content: [thinking(), text("you are on Pro.")],
        stop_reason: "end_turn",
        stop_details: null,
      }),
    ).toEqual({ outcome: "answered", text: "you are on Pro." });
  });

  // A refusal is a successful response whose content carries no answer, so the
  // stop reason has to be read before the content is.
  it("reads a refusal as a decline, with the category it names", () => {
    expect(
      replyFrom({ content: [], stop_reason: "refusal", stop_details: refusal("cyber") }),
    ).toEqual({ outcome: "declined", category: "cyber" });
  });

  it("declines without a category for a refusal that names none", () => {
    expect(
      replyFrom({ content: [], stop_reason: "refusal", stop_details: refusal(null) }),
    ).toEqual({ outcome: "declined", category: null });
  });

  it("declines a response that ended well and carries no answer", () => {
    expect(
      replyFrom({ content: [thinking()], stop_reason: "end_turn", stop_details: null }),
    ).toEqual({ outcome: "declined", category: null });
  });

  it("declines a response whose only answer is whitespace", () => {
    expect(
      replyFrom({ content: [text("  \n ")], stop_reason: "end_turn", stop_details: null }),
    ).toEqual({ outcome: "declined", category: null });
  });

  // Truncation is not a failure: the customer has a message, just a clipped
  // one, and the unit it cost them bought it.
  it("bills a message the model ran out of room to finish", () => {
    const reply = replyFrom({
      content: [text("you are on Pro and")],
      stop_reason: "max_tokens",
      stop_details: null,
    });
    expect(reply).toEqual({ outcome: "answered", text: "you are on Pro and" });
    expect(billsAUnit(reply)).toBe(true);
  });
});
