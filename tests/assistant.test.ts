/**
 * What a model call owes the counter in front of it, and what an adapter owes
 * the route.
 *
 * The rule is pure and lives in the domain so the route, this test and
 * anything later that asks a model behind the same gates read one answer: the
 * unit is billed for a message and given back when there was none.
 */
import { describe, expect, it } from "vitest";
import { billsAUnit, type AssistantReply, type IAssistantProvider } from "@/domain/assistant";
import { FakeAssistantProvider } from "@/providers/fake-assistant";

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
