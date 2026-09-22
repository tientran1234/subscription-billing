import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { hashApiKey } from "@/domain/api-key";
import { ApiKeyError, authenticate, authorize, createApiKey, revokeApiKey } from "@/server/api-keys";
import { withApiKey } from "@/server/with-api-key";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("api keys", () => {
  let tenantId: string;

  beforeEach(async () => {
    await db.tenant.deleteMany();
    tenantId = (await db.tenant.create({ data: { email: `k${Date.now()}@example.test`, name: "T" } })).id;
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("stores only the hash, and the raw key authenticates", async () => {
    const { raw, key } = await createApiKey({ tenantId, env: "test", scopes: ["billing:read"] });

    const row = await db.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(row.keyHash).toBe(hashApiKey(raw));
    expect(JSON.stringify(row)).not.toContain(raw);
    expect((await authenticate(raw)).id).toBe(key.id);
  });

  it("rejects unknown and revoked keys with the same 401", async () => {
    const { raw, key } = await createApiKey({ tenantId, env: "test", scopes: ["billing:read"] });
    await expect(authenticate("sk_test_" + "0".repeat(48))).rejects.toMatchObject({ status: 401 });

    await revokeApiKey(key.id);
    await expect(authenticate(raw)).rejects.toMatchObject({ status: 401, message: "invalid api key" });
  });

  it("refuses a scope the key was not granted", async () => {
    const { raw } = await createApiKey({ tenantId, env: "test", scopes: ["billing:read"] });
    await expect(authorize(raw, "assistant:use")).rejects.toMatchObject({ status: 403 });
  });

  it("meters every call and returns 429 past the monthly limit", async () => {
    const { raw } = await createApiKey({ tenantId, env: "test", scopes: ["assistant:use"], quotaLimit: 2 });
    await authorize(raw, "assistant:use");
    await authorize(raw, "assistant:use");
    await expect(authorize(raw, "assistant:use")).rejects.toBeInstanceOf(ApiKeyError);
    await expect(authorize(raw, "assistant:use")).rejects.toMatchObject({ status: 429 });
  });

  it("withApiKey puts quota headers on the response and maps errors to status codes", async () => {
    const { raw } = await createApiKey({ tenantId, env: "test", scopes: ["assistant:use"], quotaLimit: 5 });
    const handler = withApiKey("assistant:use", async (_req, ctx) => Response.json({ tenant: ctx.tenantId }));

    const ok = await handler(new Request("http://x/", { headers: { authorization: `Bearer ${raw}` } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ tenant: tenantId });
    expect(ok.headers.get("x-quota-used")).toBe("1");
    expect(ok.headers.get("x-quota-limit")).toBe("5");

    const missing = await handler(new Request("http://x/"));
    expect(missing.status).toBe(401);

    const wrongScope = withApiKey("billing:write", async () => new Response("no"));
    expect((await wrongScope(new Request("http://x/", { headers: { "x-api-key": raw } }))).status).toBe(403);
  });
});
