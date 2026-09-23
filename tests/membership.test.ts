import { describe, expect, it } from "vitest";
import { isMemberOf, resolveTenant, type Principal } from "@/domain/membership";

const principal = (...tenantIds: string[]): Principal => ({
  userId: "u1",
  memberships: tenantIds.map((tenantId) => ({ tenantId })),
});

describe("tenant resolution", () => {
  it("uses the only membership when no tenant is named", () => {
    expect(resolveTenant(principal("t1"))).toEqual({ ok: true, tenantId: "t1" });
  });

  it("refuses to guess when the caller belongs to several tenants", () => {
    expect(resolveTenant(principal("t1", "t2"))).toEqual({ ok: false, reason: "ambiguous" });
    expect(resolveTenant(principal("t1", "t2"), "t2")).toEqual({ ok: true, tenantId: "t2" });
  });

  it("refuses a tenant the caller is not a member of", () => {
    expect(resolveTenant(principal("t1"), "t2")).toEqual({ ok: false, reason: "forbidden" });
  });

  it("reports an unknown tenant exactly like one the caller may not touch", () => {
    // Same reason on purpose: a distinct "no such tenant" would confirm which
    // ids exist to anyone who can sign in.
    expect(resolveTenant(principal("t1"), "does-not-exist")).toEqual(
      resolveTenant(principal("t1"), "t2"),
    );
  });

  it("grants nothing to a user with no tenant", () => {
    expect(resolveTenant(principal())).toEqual({ ok: false, reason: "no_tenant" });
    expect(resolveTenant(principal(), "t1")).toEqual({ ok: false, reason: "forbidden" });
    expect(isMemberOf(principal(), "t1")).toBe(false);
  });

  it("treats an empty requested tenant as none given, not as a match", () => {
    expect(resolveTenant(principal("t1"), "")).toEqual({ ok: true, tenantId: "t1" });
    expect(resolveTenant(principal("t1", "t2"), "")).toEqual({ ok: false, reason: "ambiguous" });
  });
});
