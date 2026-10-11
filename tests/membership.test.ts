import { describe, expect, it } from "vitest";
import { isMemberOf, resolveTenant, type Principal } from "@/domain/membership";
import type { Role } from "@/domain/role";

const principal = (...tenantIds: string[]): Principal => ({
  userId: "u1",
  memberships: tenantIds.map((tenantId) => ({ tenantId, role: "admin" })),
});

const inRoles = (...pairs: [string, Role][]): Principal => ({
  userId: "u1",
  memberships: pairs.map(([tenantId, role]) => ({ tenantId, role })),
});

describe("tenant resolution", () => {
  it("uses the only membership when no tenant is named", () => {
    expect(resolveTenant(principal("t1"))).toEqual({ ok: true, tenantId: "t1", role: "admin" });
  });

  it("refuses to guess when the caller belongs to several tenants", () => {
    expect(resolveTenant(principal("t1", "t2"))).toEqual({ ok: false, reason: "ambiguous" });
    expect(resolveTenant(principal("t1", "t2"), "t2")).toEqual({
      ok: true,
      tenantId: "t2",
      role: "admin",
    });
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

  it("answers with the role of the membership it matched, not of another one", () => {
    // The role has to come from the same membership the tenant did: somebody
    // who administers one workspace and only reads another must not carry the
    // first role into the second.
    const caller = inRoles(["t1", "admin"], ["t2", "member"]);
    expect(resolveTenant(caller, "t1")).toEqual({ ok: true, tenantId: "t1", role: "admin" });
    expect(resolveTenant(caller, "t2")).toEqual({ ok: true, tenantId: "t2", role: "member" });
  });

  it("treats an empty requested tenant as none given, not as a match", () => {
    expect(resolveTenant(principal("t1"), "")).toEqual({
      ok: true,
      tenantId: "t1",
      role: "admin",
    });
    expect(resolveTenant(principal("t1", "t2"), "")).toEqual({ ok: false, reason: "ambiguous" });
  });
});
