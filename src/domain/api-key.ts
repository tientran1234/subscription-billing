/**
 * API keys: format, hashing, scopes. Pure — no I/O — so every rule here is
 * unit-testable without a database.
 */
import { createHash, randomBytes } from "node:crypto";

export type KeyEnv = "live" | "test";

/** `sk_<env>_<48 hex>`. Shown to the caller once. */
export function generateApiKey(env: KeyEnv): string {
  return `sk_${env}_${randomBytes(24).toString("hex")}`;
}

/** What gets stored and looked up. Never the raw key. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Non-secret prefix for listings: `sk_live_3f9a1c`. */
export function displayPrefix(raw: string): string {
  const m = raw.match(/^sk_(live|test)_/);
  const head = m ? m[0] : "";
  return head + raw.slice(head.length, head.length + 6);
}

export function envFromKey(raw: string): KeyEnv | null {
  const m = raw.match(/^sk_(live|test)_[0-9a-f]{48}$/);
  return (m?.[1] as KeyEnv | undefined) ?? null;
}

export const SCOPES = ["billing:read", "billing:write", "assistant:use"] as const;
export type Scope = (typeof SCOPES)[number];

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

/**
 * Does `granted` cover `needed`? Exact match, `namespace:*`, or `*`.
 * Wildcards are granted by an admin, never requested by a caller.
 */
export function hasScope(granted: readonly string[], needed: Scope): boolean {
  if (granted.includes("*") || granted.includes(needed)) return true;
  const namespace = needed.split(":")[0];
  return granted.includes(`${namespace}:*`);
}
