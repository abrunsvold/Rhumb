import { describe, it, expect } from "vitest";
import { reduceRegistry } from "../src/lib/registryStore";
import type { RegistrySnapshot } from "../src/lib/types";

const snap = (ids: string[]): RegistrySnapshot => ({
  surfaces: ids.map((id) => ({
    id,
    title: `T-${id}`,
    url: `/surfaces/${id}/`,
    kind: "file",
    created: "t",
    updated: "t",
  })),
});

describe("reduceRegistry", () => {
  it("maps a snapshot to tabs", () => {
    expect(reduceRegistry(snap(["a", "b"]))).toEqual([
      { id: "a", title: "T-a", url: "/surfaces/a/" },
      { id: "b", title: "T-b", url: "/surfaces/b/" },
    ]);
  });

  it("an empty snapshot yields no tabs", () => {
    expect(reduceRegistry(snap([]))).toEqual([]);
  });

  it("a later snapshot fully replaces the tab list", () => {
    const first = reduceRegistry(snap(["a", "b"]));
    const second = reduceRegistry(snap(["c"]));
    expect(first.map((t) => t.id)).toEqual(["a", "b"]);
    expect(second.map((t) => t.id)).toEqual(["c"]);
  });
});
