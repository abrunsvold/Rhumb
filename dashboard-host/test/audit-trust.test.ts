import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit } from "../src/data/audit.js";
import { loadTrust, isTrusted, addTrust } from "../src/data/trust.js";
import type { AuditEntry } from "../src/data/types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-at-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("appendAudit", () => {
  it("appends JSONL lines", () => {
    const p = join(dir, "a.jsonl");
    const e: AuditEntry = { ts: "t1", source: "ops", surfaceId: "d1", op: { kind: "delete", table: "t", where: { id: 1 } }, decision: "executed", rowCount: 1 };
    appendAudit(p, e);
    appendAudit(p, { ...e, ts: "t2", decision: "denied" });
    const lines = readFileSync(p, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).ts).toBe("t1");
    expect(JSON.parse(lines[1]).decision).toBe("denied");
  });
});

describe("trust", () => {
  it("loadTrust returns [] for a missing file", () => {
    expect(loadTrust(join(dir, "nope.json"))).toEqual([]);
  });

  it("isTrusted matches a pair and is false for null surfaceId", () => {
    const trust = [{ source: "ops", surfaceId: "d1" }];
    expect(isTrusted(trust, "ops", "d1")).toBe(true);
    expect(isTrusted(trust, "ops", "d2")).toBe(false);
    expect(isTrusted(trust, "rep", "d1")).toBe(false);
    expect(isTrusted(trust, "ops", null)).toBe(false);
  });

  it("addTrust persists and dedupes", () => {
    const p = join(dir, "trust.json");
    const a = addTrust(p, { source: "ops", surfaceId: "d1" });
    expect(a).toEqual([{ source: "ops", surfaceId: "d1" }]);
    const b = addTrust(p, { source: "ops", surfaceId: "d1" }); // dup
    expect(b).toEqual([{ source: "ops", surfaceId: "d1" }]);
    const c = addTrust(p, { source: "ops", surfaceId: "d2" });
    expect(c).toHaveLength(2);
    expect(loadTrust(p)).toEqual(c);
  });
});
