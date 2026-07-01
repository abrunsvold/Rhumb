import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWrite, PendingQueue, type WriteDeps } from "../src/data/writes.js";
import type { QueryExecutor, DataOp } from "../src/data/types.js";

let dir: string;
let calls: { text: string; params: unknown[] }[];
const fakeExecutor: QueryExecutor = {
  async run(sql) { calls.push(sql); return { rows: [], rowCount: 3 }; },
};
let n: number;
function deps(): WriteDeps {
  return { getExecutor: () => fakeExecutor, auditPath: join(dir, "audit.jsonl"), now: () => "T", id: () => `p${++n}` };
}
const op: DataOp = { kind: "delete", table: "t", where: { id: 1 } };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-w-")); calls = []; n = 0; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("executeWrite", () => {
  it("runs parameterized SQL and audits an executed write", async () => {
    const d = deps();
    const r = await executeWrite(d, "ops", op, "d1");
    expect(r.rowCount).toBe(3);
    expect(calls[0]).toEqual({ text: 'DELETE FROM "t" WHERE "id" = $1', params: [1] });
    const line = JSON.parse(readFileSync(d.auditPath, "utf8").trim());
    expect(line).toMatchObject({ source: "ops", surfaceId: "d1", decision: "executed", rowCount: 3 });
  });

  it("audits an error and rethrows when the executor fails", async () => {
    const failing: QueryExecutor = { async run() { throw new Error("boom"); } };
    const d = { ...deps(), getExecutor: () => failing };
    await expect(executeWrite(d, "ops", op, "d1")).rejects.toThrow("boom");
    const line = JSON.parse(readFileSync(d.auditPath, "utf8").trim());
    expect(line).toMatchObject({ decision: "error", error: "boom" });
  });
});

describe("PendingQueue", () => {
  it("enqueues, lists, and exposes pending status", () => {
    const q = new PendingQueue(deps());
    const w = q.enqueue("ops", op, "d1");
    expect(w).toMatchObject({ pendingId: "p1", source: "ops", surfaceId: "d1", createdAt: "T" });
    expect(q.list()).toHaveLength(1);
    expect(q.get("p1")).toEqual({ status: "pending" });
  });

  it("resolve approve executes, audits, and flips status to executed", async () => {
    const d = deps();
    const q = new PendingQueue(d);
    q.enqueue("ops", op, "d1");
    await q.resolve("p1", "approve");
    expect(calls).toHaveLength(1);
    expect(q.get("p1")).toEqual({ status: "executed", result: { rowCount: 3 } });
    expect(existsSync(d.auditPath)).toBe(true);
  });

  it("resolve deny audits and flips status to denied without executing", async () => {
    const d = deps();
    const q = new PendingQueue(d);
    q.enqueue("ops", op, "d1");
    await q.resolve("p1", "deny");
    expect(calls).toHaveLength(0);
    expect(q.get("p1")).toEqual({ status: "denied" });
    const line = JSON.parse(readFileSync(d.auditPath, "utf8").trim());
    expect(line.decision).toBe("denied");
  });

  it("notifies subscribers on add and resolve", async () => {
    const q = new PendingQueue(deps());
    const events: string[] = [];
    q.subscribe((kind) => events.push(kind));
    q.enqueue("ops", op, "d1");
    await q.resolve("p1", "deny");
    expect(events).toEqual(["added", "resolved"]);
  });
});
