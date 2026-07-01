import { describe, it, expect } from "vitest";
import { PendingActions } from "../src/infra/pending.js";

function mk() {
  let n = 0;
  return new PendingActions({ now: () => "T", id: () => `a${++n}` });
}

describe("PendingActions", () => {
  it("enqueue returns an action and a decision promise that resolves on resolve(approve)", async () => {
    const q = mk();
    const { action, decision } = q.enqueue("destroy_vm", { id: 9 });
    expect(action).toEqual({ pendingId: "a1", tool: "destroy_vm", input: { id: 9 }, createdAt: "T" });
    expect(q.list()).toHaveLength(1);
    q.resolve("a1", "approve");
    expect(await decision).toBe("approve");
    expect(q.list()).toHaveLength(0); // no longer pending
  });

  it("resolve(deny) resolves the promise with deny", async () => {
    const q = mk();
    const { decision } = q.enqueue("provision_database", { name: "x" });
    q.resolve("a1", "deny");
    expect(await decision).toBe("deny");
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
