import { describe, expect, it } from "vitest";
import {
  canChangeWorkspace,
  canRemoveMember,
  checkRoleChange,
  isLastAdmin,
  roleFrom,
  type Role,
  type RoleHolder,
} from "@/domain/role";

const holders = (...pairs: [string, Role][]): RoleHolder[] =>
  pairs.map(([userId, role]) => ({ userId, role }));

describe("what a role may do", () => {
  it("lets an admin change the workspace and a member only read it", () => {
    expect(canChangeWorkspace("admin")).toBe(true);
    expect(canChangeWorkspace("member")).toBe(false);
  });

  it("reads anything it does not recognise as the role that may change nothing", () => {
    // Fail closed: a role from a newer deploy, a column edited by hand or a
    // string off a request body must never widen into every power there is.
    expect(roleFrom("admin")).toBe("admin");
    expect(roleFrom("member")).toBe("member");
    for (const value of ["owner", "ADMIN", "", null, undefined, 1, {}, ["admin"]]) {
      expect(canChangeWorkspace(roleFrom(value))).toBe(false);
    }
  });
});

describe("removing somebody", () => {
  it("lets anybody leave a workspace of their own accord", () => {
    // Leaving is not an administrative act, and was allowed before roles
    // existed: a role should not be able to trap somebody in a workspace.
    expect(canRemoveMember({ userId: "u1", role: "member" }, "u1")).toBe(true);
    expect(canRemoveMember({ userId: "u1", role: "admin" }, "u1")).toBe(true);
  });

  it("takes an admin to remove anybody else", () => {
    expect(canRemoveMember({ userId: "u1", role: "member" }, "u2")).toBe(false);
    expect(canRemoveMember({ userId: "u1", role: "admin" }, "u2")).toBe(true);
  });
});

describe("the last admin", () => {
  it("is the one admin left, whoever else is in the workspace", () => {
    expect(isLastAdmin("u1", holders(["u1", "admin"], ["u2", "member"]))).toBe(true);
    expect(isLastAdmin("u2", holders(["u1", "admin"], ["u2", "member"]))).toBe(false);
    expect(isLastAdmin("u1", holders(["u1", "admin"], ["u2", "admin"]))).toBe(false);
  });

  it("cannot be demoted, because nobody left could change the workspace", () => {
    const sole = holders(["u1", "admin"], ["u2", "member"], ["u3", "member"]);
    expect(checkRoleChange("u1", "member", sole)).toBe("last_admin");
    // With a second admin the same demotion is fine: somebody is still able to
    // cancel the subscription the workspace is being billed for.
    expect(checkRoleChange("u1", "member", holders(["u1", "admin"], ["u2", "admin"]))).toBeNull();
  });

  it("may still be promoted, which is what hands the role over", () => {
    const members = holders(["u1", "admin"], ["u2", "member"]);
    expect(checkRoleChange("u2", "admin", members)).toBeNull();
  });

  it("is not refused for setting the role they already hold", () => {
    // A no-op is not a demotion. The alternative is the sole admin clicking
    // "make admin" on their own row and being told they are the last one.
    expect(checkRoleChange("u1", "admin", holders(["u1", "admin"]))).toBeNull();
  });

  it("answers for somebody who is not in the workspace at all", () => {
    expect(checkRoleChange("u9", "admin", holders(["u1", "admin"]))).toBe("not_a_member");
  });
});
