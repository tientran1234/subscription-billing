/**
 * The rule that decides a replay, over rows held in the test rather than in a
 * database: who the event belongs to is the question, and it is one a pure
 * function can answer.
 */
import { describe, expect, it } from "vitest";
import type { BillingEvent } from "@/domain/billing-event";
import { checkReplay } from "@/domain/replay";

const event: BillingEvent = {
  providerEventId: "evt_1",
  type: "payment_failed",
  providerRef: "sub_1",
};

describe("checkReplay", () => {
  it("re-applies an event found by the caller's own subscription", () => {
    expect(checkReplay("ten_1", event, { tenantId: "ten_1" })).toEqual({ ok: true, event });
  });

  // The gateway is asked first, so an id nobody has an event for gets this far
  // as a null. Refusing it here keeps "that id is not a thing" one answer
  // rather than a crash in whichever route was running.
  it("refuses an id the gateway holds no event under", () => {
    expect(checkReplay("ten_1", null, null)).toEqual({ ok: false, reason: "no_event" });
  });

  it("refuses an event that matches no subscription here", () => {
    expect(checkReplay("ten_1", event, null)).toEqual({ ok: false, reason: "not_found" });
  });

  // The guarantee the endpoint exists on: an event id names something at the
  // gateway, so without this a signed-in member of any workspace could hand
  // over another workspace's id and move its subscription.
  it("refuses an event about another workspace's subscription", () => {
    expect(checkReplay("ten_1", event, { tenantId: "ten_2" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  // The event comes back out of the rule rather than being read again by the
  // caller: what gets applied has to be the copy the gateway handed over and
  // the ownership check was made against.
  it("hands back the gateway's own event, not the id it was asked about", () => {
    const resolved = checkReplay("ten_1", event, { tenantId: "ten_1" });
    expect(resolved.ok && resolved.event).toBe(event);
  });
});
