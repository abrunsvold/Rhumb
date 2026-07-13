import { describe, it, expect } from "vitest";
import { reducePending, type PendingItem } from "../src/lib/pendingStore";

const write = (id: string) => ({ pendingId: id, source: "ops", op: { kind: "insert" }, surfaceId: "d1" });

describe("reducePending", () => {
  it("adds on an added event", () => {
    const list = reducePending([], { type: "added", write: write("p1") }, "data");
    expect(list.map((x: PendingItem) => x.pendingId)).toEqual(["p1"]);
  });

  it("dedupes by pendingId", () => {
    const list = reducePending([{ origin: "data", ...write("p1") }], { type: "added", write: write("p1") }, "data");
    expect(list).toHaveLength(1);
  });

  it("removes on a resolved event", () => {
    const list = reducePending(
      [{ origin: "data", ...write("p1") }, { origin: "data", ...write("p2") }],
      { type: "resolved", write: write("p1") },
      "data",
    );
    expect(list.map((x: PendingItem) => x.pendingId)).toEqual(["p2"]);
  });

  it("ignores unknown events", () => {
    const before = [{ origin: "data" as const, ...write("p1") }];
    expect(reducePending(before, { type: "junk" }, "data")).toBe(before);
  });

  it("tags items with their origin and keeps data + infra items distinct", () => {
    const data = { type: "added", write: { pendingId: "p1", source: "ops", op: {}, surfaceId: "d1" } };
    const infra = { type: "added", action: { pendingId: "a1", tool: "destroy_vm", input: { id: 9 } } };
    let list = reducePending([], data, "data");
    list = reducePending(list, infra, "infra");
    expect(list.map((x) => [x.origin, x.pendingId])).toEqual([["data", "p1"], ["infra", "a1"]]);
  });
});

describe("reducePending (proposals)", () => {
  it("threads proposedBy through infra events and ignores unknown event kinds", () => {
    const added = reducePending([], { type: "added", action: { pendingId: "a1", tool: "start_service", input: { id: "p" }, proposedBy: "watchdog" } }, "infra");
    expect(added[0]).toMatchObject({ pendingId: "a1", tool: "start_service", proposedBy: "watchdog" });
    const afterExec = reducePending(added, { type: "executed", action: { pendingId: "a1" } }, "infra");
    expect(afterExec).toEqual(added); // unknown kinds leave the list untouched
  });
});
