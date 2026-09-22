import { describe, expect, it } from "vitest";
import {
  displayPrefix,
  envFromKey,
  generateApiKey,
  hashApiKey,
  hasScope,
} from "@/domain/api-key";

describe("api key format", () => {
  it("encodes the environment in a recognisable prefix", () => {
    expect(generateApiKey("live")).toMatch(/^sk_live_[0-9a-f]{48}$/);
    expect(envFromKey(generateApiKey("test"))).toBe("test");
    expect(envFromKey("sk_prod_abc")).toBeNull();
  });

  it("is unique per call", () => {
    expect(generateApiKey("live")).not.toBe(generateApiKey("live"));
  });

  it("hashes deterministically and irreversibly", () => {
    const raw = generateApiKey("live");
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
    expect(hashApiKey(raw)).toHaveLength(64);
    expect(hashApiKey(raw)).not.toContain(raw.slice(8, 20));
  });

  it("shows enough prefix to recognise a key, not enough to use it", () => {
    const raw = generateApiKey("live");
    const prefix = displayPrefix(raw);
    expect(prefix).toMatch(/^sk_live_[0-9a-f]{6}$/);
    expect(raw.startsWith(prefix)).toBe(true);
  });
});

describe("scopes", () => {
  it("matches exact scopes", () => {
    expect(hasScope(["billing:read"], "billing:read")).toBe(true);
    expect(hasScope(["billing:read"], "billing:write")).toBe(false);
  });

  it("expands namespace and global wildcards", () => {
    expect(hasScope(["billing:*"], "billing:write")).toBe(true);
    expect(hasScope(["billing:*"], "assistant:use")).toBe(false);
    expect(hasScope(["*"], "assistant:use")).toBe(true);
  });

  it("grants nothing to an empty key", () => {
    expect(hasScope([], "billing:read")).toBe(false);
  });
});
