import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// The real module builds a NextAuth instance at import time; the wrapper only
// ever needs the one function it exports.
const auth = vi.hoisted(() => vi.fn<() => Promise<Session | null>>());
vi.mock("@/lib/auth", () => ({ auth }));

const { SessionError, TENANT_HEADER, sessionContextFrom, withSession } = await import(
  "@/server/with-session"
);

function session(userId: string, ...tenantIds: string[]): Session {
  return {
    user: { id: userId, email: "a@example.test" },
    memberships: tenantIds.map((tenantId) => ({ tenantId })),
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

  it("passes a route's own arguments through to the handler", async () => {
    auth.mockResolvedValue(session("u1", "mine"));
    const route = withSession(async (_req, ctx, params: { id: string }) =>
      Response.json({ id: params.id, tenantId: ctx.tenantId }),
    );

    const response = await route(requestClaiming("victim"), { id: "key_1" });
    expect(await response.json()).toEqual({ id: "key_1", tenantId: "mine" });
  });
});
