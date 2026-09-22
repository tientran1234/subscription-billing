import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_STATUSES,
  canTransition,
  predecessorsOf,
  statusForEvent,
} from "@/domain/subscription";

describe("subscription state machine", () => {
  it("never moves backwards out of a terminal status", () => {
    for (const terminal of ["CANCELED", "EXPIRED"] as const) {
      for (const to of SUBSCRIPTION_STATUSES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("allows the dunning round trip ACTIVE → PAST_DUE → ACTIVE", () => {
    expect(canTransition("ACTIVE", "PAST_DUE")).toBe(true);
    expect(canTransition("PAST_DUE", "ACTIVE")).toBe(true);
  });

  it("refuses to activate the same subscription twice", () => {
    // This is what makes a replayed activation a no-op at the database level.
    expect(canTransition("ACTIVE", "ACTIVE")).toBe(false);
    expect(predecessorsOf("ACTIVE")).not.toContain("ACTIVE");
  });

  it("predecessorsOf agrees with canTransition for every pair", () => {
    for (const to of SUBSCRIPTION_STATUSES) {
      const allowed = predecessorsOf(to);
      for (const from of SUBSCRIPTION_STATUSES) {
        expect(allowed.includes(from)).toBe(canTransition(from, to));
      }
    }
  });

  it("maps provider events to statuses, ignoring unknown ones", () => {
    expect(statusForEvent("subscription_activated")).toBe("ACTIVE");
    expect(statusForEvent("payment_failed")).toBe("PAST_DUE");
    expect(statusForEvent("subscription_canceled")).toBe("CANCELED");
    expect(statusForEvent("subscription_expired")).toBe("EXPIRED");
    expect(statusForEvent("unknown")).toBeNull();
  });
});
