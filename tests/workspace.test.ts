/**
 * The route that answers a 409: which workspaces a session may act for, and
 * which one this browser is to be shown.
 *
 * It is the one route that runs in front of `withSession`, because the wrapper
 * refuses an account in several workspaces before a handler sees it. So the
 * membership check is this file's own, and that is what these tests are
 * mostly about: a route that sets a tenant cookie has to be unable to set one
 * for a workspace the account does not hold.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import type { Role } from "@/domain/role";

const auth = vi.hoisted(() => vi.fn<() => Promise<Session | null>>());
vi.mock("@/lib/auth", () => ({ auth }));

// Mocked rather than run: what it reads is covered against a real Postgres in
// workspaces.integration.test.ts, and importing it here would open a client.
const workspacesFor = vi.hoisted(() => vi.fn());
vi.mock("@/server/workspaces", () => ({ workspacesFor }));

const { TENANT_COOKIE } = await import("@/server/with-session");
const { GET, POST } = await import("@/app/api/workspace/route");

function session(...pairs: [string, Role][]): Session {
  return {
    user: { id: "u1", email: "a@example.test" },
    memberships: pairs.map(([tenantId, role]) => ({ tenantId, role })),
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

const choosing = (tenantId: unknown, cookie?: string): Request =>
  new Request("http://x/api/workspace", {
    method: "POST",
    headers: cookie ? { cookie: `${TENANT_COOKIE}=${cookie}` } : undefined,
    body: JSON.stringify({ tenantId }),
  });

const asking = (cookie?: string): Request =>
  new Request("http://x/api/workspace", {
    headers: cookie ? { cookie: `${TENANT_COOKIE}=${cookie}` } : undefined,
  });

describe("choosing a workspace", () => {
  beforeEach(() => auth.mockReset());

  it("remembers a workspace the account belongs to", async () => {
    auth.mockResolvedValue(session(["t1", "admin"], ["t2", "member"]));

    const response = await POST(choosing("t2"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenantId: "t2", role: "member" });
    expect(response.headers.get("set-cookie")).toMatch(
      new RegExp(`^${TENANT_COOKIE}=t2;`),
    );
  });

  it("refuses to remember a workspace the account does not belong to", async () => {
    // The guarantee: this is the only route that writes the cookie every other
    // one resolves its tenant from, so a body it took at its word would be a
    // way into somebody else's workspace from a signed-in account.
    auth.mockResolvedValue(session(["t1", "admin"]));

    const response = await POST(choosing("victim"));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a caller with no session", async () => {
    auth.mockResolvedValue(null);
    const response = await POST(choosing("t1"));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a body that is not a workspace id", async () => {
    auth.mockResolvedValue(session(["t1", "admin"]));
    for (const body of [undefined, 7, ""]) {
      const response = await POST(choosing(body));
      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("replaces the workspace already remembered, rather than keeping it", async () => {
    // The one request here whose subject is a tenant in the body: a switch
    // from t1 to t2 would be unmakeable if the cookie it is replacing won.
    auth.mockResolvedValue(session(["t1", "admin"], ["t2", "admin"]));

    const response = await POST(choosing("t2", "t1"));
    expect(await response.json()).toMatchObject({ tenantId: "t2" });
    expect(response.headers.get("set-cookie")).toMatch(
      new RegExp(`^${TENANT_COOKIE}=t2;`),
    );
  });
});

describe("listing the workspaces a session may act for", () => {
  beforeEach(() => {
    auth.mockReset();
    workspacesFor.mockReset();
    workspacesFor.mockResolvedValue([
      { tenantId: "t1", role: "admin", name: "Acme" },
      { tenantId: "t2", role: "member", name: "Globex" },
    ]);
  });

  it("names the one in force beside them", async () => {
    auth.mockResolvedValue(session(["t1", "admin"], ["t2", "member"]));

    expect(await (await GET(asking("t2"))).json()).toEqual({
      workspaces: [
        { tenantId: "t1", role: "admin", name: "Acme" },
        { tenantId: "t2", role: "member", name: "Globex" },
      ],
      current: "t2",
    });
  });

  it("says none is in force while the account still has to choose", async () => {
    // Which is the state this route exists for: the caller met a 409 and has
    // nowhere else to learn the ids it may name in `x-tenant-id`.
    auth.mockResolvedValue(session(["t1", "admin"], ["t2", "member"]));
    expect(await (await GET(asking())).json()).toMatchObject({ current: null });
  });

  it("refuses a caller with no session", async () => {
    auth.mockResolvedValue(null);
    expect((await GET(asking())).status).toBe(401);
    expect(workspacesFor).not.toHaveBeenCalled();
  });
});
