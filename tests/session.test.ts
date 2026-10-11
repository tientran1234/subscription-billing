import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import type { Role } from "@/domain/role";

// The real module builds a NextAuth instance at import time; the wrapper only
// ever needs the one function it exports.
const auth = vi.hoisted(() => vi.fn<() => Promise<Session | null>>());
vi.mock("@/lib/auth", () => ({ auth }));

const {
  SessionError,
  TENANT_COOKIE,
  TENANT_HEADER,
  chosenWorkspaceCookie,
  sessionContextFrom,
  withSession,
} = await import("@/server/with-session");

function session(userId: string, ...tenantIds: string[]): Session {
  return asRole("admin", userId, ...tenantIds);
}

/** The same session, held in a named role rather than the default admin. */
function asRole(role: Role, userId: string, ...tenantIds: string[]): Session {
  return {
    user: { id: userId, email: "a@example.test" },
    memberships: tenantIds.map((tenantId) => ({ tenantId, role })),
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

/** A request that names a different tenant everywhere a caller could. */
function requestClaiming(tenantId: string, header?: string): Request {
  return new Request("http://x/", {
    method: "POST",
    headers: header ? { [TENANT_HEADER]: header } : undefined,
    body: JSON.stringify({ tenantId, planKey: "pro" }),
  });
}

/**
 * The same request, carrying the workspace a picker chose.
 *
 * Two decoys ride in front of it on purpose: another cookie entirely, and one
 * whose name starts with ours and holds a tenant this account really does
 * belong to. A parser that matched on a prefix would read `t1` out of the
 * second and every assertion below would come back with the wrong workspace.
 */
function requestCarrying(cookie: string | null, header?: string): Request {
  const decoys = `session-token=abc; ${TENANT_COOKIE}-other=t1`;
  return new Request("http://x/", {
    method: "POST",
    headers: {
      ...(header ? { [TENANT_HEADER]: header } : {}),
      cookie: cookie === null ? decoys : `${decoys}; ${TENANT_COOKIE}=${cookie}`,
    },
    body: JSON.stringify({ tenantId: "victim" }),
  });
}

describe("session context", () => {
  it("ignores a tenant id in the body", () => {
    const ctx = sessionContextFrom(session("u1", "mine"), requestClaiming("victim"));
    expect(ctx.tenantId).toBe("mine");
  });

  it("refuses a request with no session", () => {
    expect(() => sessionContextFrom(null, requestClaiming("mine"))).toThrow(SessionError);
    expect(() => sessionContextFrom({ expires: "" } as Session, requestClaiming("mine"))).toThrow(
      /sign in/,
    );
  });

  it("bills the signed-in address, not one supplied by the caller", () => {
    expect(sessionContextFrom(session("u1", "mine"), requestClaiming("victim")).email).toBe(
      "a@example.test",
    );
  });

  it("carries what the caller may do in the tenant it resolved", () => {
    expect(sessionContextFrom(asRole("member", "u1", "mine"), requestClaiming("x")).role).toBe(
      "member",
    );
    expect(sessionContextFrom(asRole("admin", "u1", "mine"), requestClaiming("x")).role).toBe(
      "admin",
    );
  });

  it("refuses a member a route that changes the workspace, and tells them why", () => {
    const changes = { changesWorkspace: true };
    try {
      sessionContextFrom(asRole("member", "u1", "mine"), requestClaiming("x"), changes);
      expect.unreachable("a member must not get a context for a route that changes things");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionError);
      // 403 with a reason of its own, kept apart from the 403 a caller outside
      // the workspace gets: this one may read everything the change touches.
      const refusal = err as { status: number; reason?: string };
      expect(refusal.status).toBe(403);
      expect(refusal.reason).toBe("not_an_admin");
    }

    expect(
      sessionContextFrom(asRole("admin", "u1", "mine"), requestClaiming("x"), changes).tenantId,
    ).toBe("mine");
  });

  it("refuses a member before the role is read, when the tenant is not theirs", () => {
    // Order matters: somebody outside the workspace must not be able to tell a
    // tenant that exists from one that does not by which refusal comes back.
    expect(() =>
      sessionContextFrom(asRole("admin", "u1", "t1"), requestClaiming("x", "t2"), {
        changesWorkspace: true,
      }),
    ).toThrow(/no access/);
  });

  it("accepts the tenant header only for a tenant the user belongs to", () => {
    expect(
      sessionContextFrom(session("u1", "t1", "t2"), requestClaiming("victim", "t2")).tenantId,
    ).toBe("t2");
    expect(() =>
      sessionContextFrom(session("u1", "t1"), requestClaiming("victim", "victim")),
    ).toThrow(/no access/);
  });
});

describe("withSession", () => {
  beforeEach(() => auth.mockReset());

  it("hands the handler the session's tenant, whatever the body says", async () => {
    auth.mockResolvedValue(session("u1", "mine"));
    const handler = withSession(async (_req, ctx) => Response.json({ tenantId: ctx.tenantId }));

    const response = await handler(requestClaiming("victim"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenantId: "mine" });
  });

  it("never runs the handler for a caller without access", async () => {
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const route = withSession(handler);

    auth.mockResolvedValue(null);
    expect((await route(requestClaiming("victim"))).status).toBe(401);

    auth.mockResolvedValue(session("u1", "t1"));
    expect((await route(requestClaiming("victim", "t2"))).status).toBe(403);

    auth.mockResolvedValue(session("u1"));
    expect((await route(requestClaiming("victim"))).status).toBe(403);

    auth.mockResolvedValue(session("u1", "t1", "t2"));
    expect((await route(requestClaiming("victim"))).status).toBe(409);

    expect(handler).not.toHaveBeenCalled();
  });

  it("never runs a workspace-changing handler for a member", async () => {
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const route = withSession(handler, { changesWorkspace: true });

    auth.mockResolvedValue(asRole("member", "u1", "mine"));
    const refused = await route(requestClaiming("mine"));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: expect.any(String),
      reason: "not_an_admin",
    });
    expect(handler).not.toHaveBeenCalled();

    // The same route, the same request, an admin: the gate is the role and
    // nothing else about the call.
    auth.mockResolvedValue(asRole("admin", "u1", "mine"));
    expect((await route(requestClaiming("mine"))).status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("lets a member through a route that only reads", async () => {
    auth.mockResolvedValue(asRole("member", "u1", "mine"));
    const route = withSession(async (_req, ctx) => Response.json({ role: ctx.role }));
    const response = await route(requestClaiming("mine"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ role: "member" });
  });

  it("passes a route's own arguments through to the handler", async () => {
    auth.mockResolvedValue(session("u1", "mine"));
    const route = withSession(async (_req, ctx, params: { id: string }) =>
      Response.json({ id: params.id, tenantId: ctx.tenantId }),
    );

    const response = await route(requestClaiming("victim"), { id: "key_1" });
    expect(await response.json()).toEqual({ id: "key_1", tenantId: "mine" });
  });
});

describe("the workspace a picker chose", () => {
  it("resolves the tenant a page cannot name in a header", () => {
    // A browser navigating to a page sets no headers of its own, so the cookie
    // is the only way a choice survives a link being clicked.
    const ctx = sessionContextFrom(session("u1", "t1", "t2"), requestCarrying("t2"));
    expect(ctx.tenantId).toBe("t2");
  });

  it("is read off its own name and not off a cookie that starts with it", () => {
    // Only the decoys, so there is no choice here at all — and the account is
    // owed the picker rather than the workspace the decoy happens to name.
    try {
      sessionContextFrom(session("u1", "t1", "t2"), requestCarrying(null));
      expect.unreachable("a cookie that is not ours must not resolve a tenant");
    } catch (err) {
      expect((err as { status: number }).status).toBe(409);
    }
  });

  it("gives way to a tenant the request names outright", () => {
    expect(sessionContextFrom(session("u1", "t1", "t2"), requestCarrying("t2", "t1")).tenantId).toBe(
      "t1",
    );
  });

  it("is forgotten rather than refused once the account leaves that workspace", async () => {
    // 409 and not 403: the account still has two workspaces to pick between,
    // and a 403 would be a page it could not click its way off.
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const route = withSession(handler);
    auth.mockResolvedValue(session("u1", "t1", "t2"));

    expect((await route(requestCarrying("gone"))).status).toBe(409);
    expect(handler).not.toHaveBeenCalled();
  });

  it("is not carried on a request made from another site", () => {
    // SameSite=Lax is what holds this up, so the attribute is the assertion:
    // a cross-site POST sends no cookie, and an account in several workspaces
    // meets the same 409 it did before there was anything to remember.
    expect(chosenWorkspaceCookie("t2")).toMatch(/;\s*SameSite=Lax/);
    expect(chosenWorkspaceCookie("t2")).toMatch(/;\s*HttpOnly/);
    expect(chosenWorkspaceCookie("t2")).toMatch(new RegExp(`^${TENANT_COOKIE}=t2;`));
  });
});
