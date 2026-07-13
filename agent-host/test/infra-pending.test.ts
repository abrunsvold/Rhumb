import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingActions } from "../src/infra/pending.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-pending-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function mk(persistPath?: string) {
  let n = 0;
  return new PendingActions({ now: () => "T", id: () => `a${++n}`, persistPath });
}

describe("PendingActions (blocking mode — unchanged contract)", () => {
  it("enqueue returns an action and a decision promise that resolves on resolve(approve)", async () => {
    const q = mk();
    const { action, decision } = q.enqueue("destroy_vm", { id: 9 });
    expect(action).toEqual({
      pendingId: "a1", tool: "destroy_vm", input: { id: 9 }, createdAt: "T",
      mode: "blocking", status: "pending", proposedBy: "interactive",
    });
    expect(q.list()).toHaveLength(1);
    q.resolve("a1", "approve");
    expect(await decision).toBe("approve");
    expect(q.list()).toHaveLength(0); // no longer pending
    expect(q.get("a1")?.status).toBe("approved");
    expect(q.get("a1")?.resolvedAt).toBe("T");
  });

  it("resolve(deny) resolves the promise with deny", async () => {
    const q = mk();
    const { decision } = q.enqueue("provision_database", { name: "x" });
    q.resolve("a1", "deny");
    expect(await decision).toBe("deny");
    expect(q.get("a1")?.status).toBe("denied");
  });

  it("resolve returns false for an unknown or already-resolved id", () => {
    const q = mk();
    q.enqueue("start_vm", { id: 1 });
    expect(q.resolve("a1", "approve")).toBe(true);
    expect(q.resolve("a1", "deny")).toBe(false);
    expect(q.resolve("nope", "approve")).toBe(false);
  });

  it("notifies subscribers on add and resolve", () => {
    const q = mk();
    const events: string[] = [];
    q.subscribe((k) => events.push(k));
    q.enqueue("stop_vm", { id: 2 });
    q.resolve("a1", "approve");
    expect(events).toEqual(["added", "resolved"]);
  });
});

describe("PendingActions (parked mode + outcomes)", () => {
  it("parked entries record proposer and resolve without anyone awaiting", () => {
    const q = mk();
    const { action } = q.enqueue("start_service", { id: "poller" }, { mode: "parked", proposedBy: "watchdog" });
    expect(action.mode).toBe("parked");
    expect(action.proposedBy).toBe("watchdog");
    expect(q.resolve("a1", "approve")).toBe(true);
    expect(q.get("a1")?.status).toBe("approved");
  });

  it("recordOutcome sets executed/failed with detail and emits the outcome", () => {
    const q = mk();
    const events: string[] = [];
    q.subscribe((k) => events.push(k));
    q.enqueue("start_service", { id: "poller" }, { mode: "parked", proposedBy: "watchdog" });
    q.resolve("a1", "approve");
    expect(q.recordOutcome("a1", "executed", "started poller")).toBe(true);
    expect(q.get("a1")).toMatchObject({ status: "executed", result: "started poller" });
    q.enqueue("redeploy_service", { id: "x" }, { mode: "parked" });
    q.resolve("a2", "approve");
    q.recordOutcome("a2", "failed", "health gate refused");
    expect(q.get("a2")).toMatchObject({ status: "failed", error: "health gate refused" });
    expect(q.recordOutcome("nope", "executed", "x")).toBe(false);
    expect(events).toEqual(["added", "resolved", "executed", "added", "resolved", "failed"]);
  });
});

describe("PendingActions (persistence + boot expiry)", () => {
  it("persists every change and reloads across instances", () => {
    const path = join(dir, "pending-actions.json");
    const q1 = mk(path);
    q1.enqueue("start_service", { id: "poller" }, { mode: "parked", proposedBy: "watchdog" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(1);
    const q2 = mk(path);
    expect(q2.list()).toHaveLength(1);
    expect(q2.get("a1")).toMatchObject({ mode: "parked", status: "pending", proposedBy: "watchdog" });
    expect(q2.resolve("a1", "approve")).toBe(true);
    q2.recordOutcome("a1", "executed", "started poller");
    const q3 = mk(path);
    // Completed outcomes survive verbatim; only approved-but-incomplete
    // parked entries get failed on boot (covered in the next test).
    expect(q3.get("a1")).toMatchObject({ status: "executed", result: "started poller" });
  });

  it("expires stale blocking entries and fails interrupted parked executions on boot", () => {
    const path = join(dir, "pending-actions.json");
    const q1 = mk(path);
    q1.enqueue("destroy_vm", { id: 9 }); // blocking, pending
    q1.enqueue("start_service", { id: "p" }, { mode: "parked" }); // parked, pending
    q1.enqueue("redeploy_service", { id: "x" }, { mode: "parked" });
    q1.resolve("a3", "approve"); // parked, approved, never completed
    const q2 = mk(path);
    expect(q2.get("a1")?.status).toBe("expired");
    expect(q2.get("a2")?.status).toBe("pending");
    expect(q2.get("a3")).toMatchObject({ status: "failed", error: expect.stringContaining("restart") });
    expect(q2.list().map((a) => a.pendingId)).toEqual(["a2"]);
  });
});
