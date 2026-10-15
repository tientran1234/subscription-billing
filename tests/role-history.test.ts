import { describe, expect, it } from "vitest";
import { ROLE_HISTORY_WINDOW, isGrant } from "@/domain/role-history";

describe("which writes are a grant", () => {
  it("counts the first role somebody holds in a workspace", () => {
    // Nothing to replace: an invite accepted into a workspace is where most
    // people's first role comes from, and it is the grant that says who let
    // them in.
    expect(isGrant(null, "member")).toBe(true);
    expect(isGrant(null, "admin")).toBe(true);
  });

  it("counts a promotion and a demotion alike", () => {
    expect(isGrant("member", "admin")).toBe(true);
    expect(isGrant("admin", "member")).toBe(true);
  });

  it("does not count a write that leaves the role as it was", () => {
    // The role-change path allows these rather than refusing them, so they
    // arrive here in the ordinary course of things. A row for one would make
    // the date beside a role the date it was last confirmed.
    expect(isGrant("admin", "admin")).toBe(false);
    expect(isGrant("member", "member")).toBe(false);
  });
});

describe("the window", () => {
  it("is a bound the page can draw", () => {
    expect(ROLE_HISTORY_WINDOW).toBeGreaterThan(0);
    expect(Number.isInteger(ROLE_HISTORY_WINDOW)).toBe(true);
  });
});
