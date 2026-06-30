import { describe, it, expect } from "vitest";
import { addSession, type TrackedSession } from "../src/lib/session";

const s = (id: string): TrackedSession => ({ id, title: `first prompt ${id}`, createdAt: "2026-06-30T00:00:00Z" });

describe("addSession", () => {
  it("prepends a new session", () => {
    const list = addSession([s("a")], s("b"));
    expect(list.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("dedupes by id without reordering", () => {
    const before = [s("b"), s("a")];
    const after = addSession(before, s("b"));
    expect(after.map((x) => x.id)).toEqual(["b", "a"]);
    expect(after).toBe(before);
  });

  it("does not mutate the input list when prepending", () => {
    const before = [s("a")];
    const after = addSession(before, s("b"));
    expect(before.map((x) => x.id)).toEqual(["a"]);
    expect(after).not.toBe(before);
  });
});
