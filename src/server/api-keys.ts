import type { ApiKey } from "@prisma/client";
import { db } from "@/lib/db";
import {
  displayPrefix,
  generateApiKey,
  hashApiKey,
  hasScope,
  type KeyEnv,
  type Scope,
} from "@/domain/api-key";
import { meter, type MeterResult } from "./usage";

/** Auth or quota failure, carrying the HTTP status the route should return. */
export class ApiKeyError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 429,
  ) {
    super(message);
    this.name = "ApiKeyError";
  }
}

export interface CreateApiKeyInput {
  tenantId: string;
  env: KeyEnv;
  scopes: Scope[];
  quotaLimit?: number;
}

export type ApiKeyView = Omit<ApiKey, "keyHash">;

/** Mint a key. The raw value is in the return and nowhere else. */
export async function createApiKey(
  input: CreateApiKeyInput,
): Promise<{ raw: string; key: ApiKeyView }> {
  const raw = generateApiKey(input.env);
  const { keyHash: _hidden, ...key } = await db.apiKey.create({
    data: {
      tenantId: input.tenantId,
      keyHash: hashApiKey(raw),
      prefix: displayPrefix(raw),
      scopes: input.scopes,
      quotaLimit: input.quotaLimit ?? null,
    },
  });
  return { raw, key };
}

export async function revokeApiKey(id: string): Promise<void> {
  await db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
}

/** Raw key → record. Throws 401 for anything that should look identical to the caller. */
export async function authenticate(raw: string | null | undefined): Promise<ApiKey> {
  if (!raw) throw new ApiKeyError("missing api key", 401);
  const key = await db.apiKey.findUnique({ where: { keyHash: hashApiKey(raw) } });
  // Unknown and revoked return the same error on purpose: a distinct "revoked"
  // message would confirm the key once existed.
  if (!key || key.revokedAt) throw new ApiKeyError("invalid api key", 401);
  return key;
}

export function requireScope(key: ApiKey, scope: Scope): void {
  if (!hasScope(key.scopes, scope)) throw new ApiKeyError(`missing scope: ${scope}`, 403);
}

/** Count this request against the key's monthly quota; 429 once over. */
export async function meterKey(key: ApiKey): Promise<MeterResult> {
  const limit = key.quotaLimit ?? Number.POSITIVE_INFINITY;
  const result = await meter(key.tenantId, `api:${key.id}`, limit);
  if (!result.allowed) throw new ApiKeyError("monthly quota exceeded", 429);
  return result;
}

/** Everything a route needs from the key in one call. */
export async function authorize(
  raw: string | null | undefined,
  scope: Scope,
): Promise<{ key: ApiKey; usage: MeterResult }> {
  const key = await authenticate(raw);
  requireScope(key, scope);
  const usage = await meterKey(key);
  // Best-effort; a failed timestamp must not fail the request.
  void db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { key, usage };
}
