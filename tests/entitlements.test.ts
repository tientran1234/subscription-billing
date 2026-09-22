import { describe, expect, it } from "vitest";
import { canUse, entitlementsFor, remaining } from "@/domain/entitlements";

describe("entitlements", () => {
  it("gives a paying active tenant their plan", () => {
    const e = entitlementsFor("pro", "ACTIVE");
    expect(e.planKey).toBe("pro");
    expect(canUse(e, "export")).toBe(true);
  });

  it("drops a cancelled Pro tenant to Free immediately", () => {
    // The bug this guards: entitlements copied onto the user row survive the
    // cancellation and the tenant keeps paid features until someone notices.
    const e = entitlementsFor("pro", "CANCELED");
    expect(e.planKey).toBe("free");
    expect(canUse(e, "export")).toBe(false);
  });

  it("keeps access while a renewal is being retried", () => {
    expect(entitlementsFor("pro", "PAST_DUE").planKey).toBe("pro");
  });

  it("does not grant paid access before checkout completes", () => {
    expect(entitlementsFor("scale", "PENDING").planKey).toBe("free");
  });

  it("falls back to Free for a plan key that no longer exists", () => {
    expect(entitlementsFor("legacy-plan", "ACTIVE").planKey).toBe("free");
  });

  it("never reports negative quota left", () => {
    const e = entitlementsFor("free", "ACTIVE");
    expect(remaining(e, "aiMessages", 999)).toBe(0);
  });
});
