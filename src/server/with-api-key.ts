import type { ApiKey } from "@prisma/client";
import type { Scope } from "@/domain/api-key";
import { ApiKeyError, authorize } from "./api-keys";
import type { MeterResult } from "./usage";

export interface ApiKeyContext {
  key: ApiKey;
  tenantId: string;
  usage: MeterResult;
}

/** `Authorization: Bearer sk_…` or `x-api-key: sk_…`. */
function rawKeyFrom(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return request.headers.get("x-api-key");
}

/**
 * Wrap a route handler: authenticate, check scope, meter, then run. Quota
 * headers go on every response — including the 429 — so a client can back off
 * before it is cut off rather than after.
 */
export function withApiKey(
  scope: Scope,
  handler: (request: Request, ctx: ApiKeyContext) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let ctx: ApiKeyContext;
    try {
      const { key, usage } = await authorize(rawKeyFrom(request), scope);
      ctx = { key, tenantId: key.tenantId, usage };
    } catch (err) {
      if (err instanceof ApiKeyError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }

    const response = await handler(request, ctx);
    response.headers.set("x-quota-used", String(ctx.usage.used));
    if (Number.isFinite(ctx.usage.limit)) {
      response.headers.set("x-quota-limit", String(ctx.usage.limit));
    }
    return response;
  };
}
