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

  it("starts a trial from PENDING and lets it convert", () => {
    expect(canTransition("PENDING", "TRIALING")).toBe(true);
    expect(canTransition("TRIALING", "ACTIVE")).toBe(true);
  });

  it("never puts a subscription back into a trial", () => {
    // Forward-only, and this is the direction that costs money: a customer who
    // has paid once must not be handed another free month by a late or
    // replayed trial-start delivery.
    expect(canTransition("ACTIVE", "TRIALING")).toBe(false);
    expect(canTransition("PAST_DUE", "TRIALING")).toBe(false);
    expect(canTransition("TRIALING", "TRIALING")).toBe(false);
    expect(predecessorsOf("TRIALING")).toEqual(["PENDING"]);
  });

  it("lets a trial that is never paid for end every way it can", () => {
    for (const to of ["PAST_DUE", "CANCELED", "EXPIRED"] as const) {
      expect(canTransition("TRIALING", to)).toBe(true);
    }
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
    expect(statusForEvent("subscription_trialing")).toBe("TRIALING");
    expect(statusForEvent("payment_failed")).toBe("PAST_DUE");
    expect(statusForEvent("subscription_canceled")).toBe("CANCELED");
    expect(statusForEvent("subscription_expired")).toBe("EXPIRED");
    expect(statusForEvent("unknown")).toBeNull();
  });

  it("does not turn a trial-ending warning into a status", () => {
    // The trial running out is a heads-up, not an outcome. Which outcome
    // follows — a paid invoice or a failed one — is the provider's to say, and
    // it says so in a separate event.
    expect(statusForEvent("trial_ending")).toBeNull();
  });
});
