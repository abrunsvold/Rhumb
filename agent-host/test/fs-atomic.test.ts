import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "../src/fsAtomic.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-atomic-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("atomicWriteFileSync", () => {
  it("writes content, creates parent dirs, leaves no tmp residue", () => {
    const p = join(dir, "nested", "reg.json");
    atomicWriteFileSync(p, '{"a":1}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}');
    expect(readdirSync(join(dir, "nested")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("replaces an existing file atomically (rename over)", () => {
    const p = join(dir, "reg.json");
    writeFileSync(p, "old");
    atomicWriteFileSync(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
  });

  it("cleans up the tmp file and rethrows when the rename fails", () => {
    const p = join(dir, "target");
    mkdirSync(join(p, "occupied"), { recursive: true });   // target is a non-empty DIRECTORY → renameSync throws
    expect(() => atomicWriteFileSync(p, "data")).toThrow();
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);  // tmp unlinked
  });
});
