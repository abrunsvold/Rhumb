import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateSurfaceToken, resolveSurfaceToken } from "../src/surfaces/token.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "rhumb-tok-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("surface token", () => {
  it("generates a token on first call and is stable across calls", () => {
    const dir = join(root, "d1"); mkdirSync(dir);
    const t1 = getOrCreateSurfaceToken(dir);
    const t2 = getOrCreateSurfaceToken(dir);
    expect(t1).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(t2).toBe(t1);
    expect(readFileSync(join(dir, ".surface-token"), "utf8").trim()).toBe(t1);
  });

  it("resolves a token back to its surface id, and null for unknown/empty", () => {
    const dir = join(root, "sales"); mkdirSync(dir);
    const token = getOrCreateSurfaceToken(dir);
    expect(resolveSurfaceToken(root, token)).toBe("sales");
    expect(resolveSurfaceToken(root, "nope")).toBeNull();
    expect(resolveSurfaceToken(root, "")).toBeNull();
  });
});
