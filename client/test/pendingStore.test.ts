import { describe, it, expect } from "vitest";
import { reducePending, type PendingItem } from "../src/lib/pendingStore";

const write = (id: string) => ({ pendingId: id, source: "ops", op: { kind: "insert" }, surfaceId: "d1" });

describe("reducePending", () => {
  it("adds on an added event", () => {
    const list = reducePending([], { type: "added", write: write("p1") });
    expect(list.map((x: PendingItem) => x.pendingId)).toEqual(["p1"]);
  });

  it("dedupes by pendingId", () => {
    const list = reducePending([write("p1")], { type: "added", write: write("p1") });
    expect(list).toHaveLength(1);
  });

  it("removes on a resolved event", () => {
    const list = reducePending([write("p1"), write("p2")], { type: "resolved", write: write("p1") });
    expect(list.map((x: PendingItem) => x.pendingId)).toEqual(["p2"]);
  });

  it("ignores unknown events", () => {
    const before = [write("p1")];
    expect(reducePending(before, { type: "junk" })).toBe(before);
  });
});
