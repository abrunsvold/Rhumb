import { describe, it, expect } from "vitest";
import { buildLineage, buildSurfaceLineage } from "../src/lib/lineage";
import type { OntologyNode } from "../src/lib/types";

const n = (id: string, title: string, rels: string[] = []): OntologyNode => ({
  type: "service", id, title, managed: "system", props: {},
  relationships: rels.map((target) => ({ edge: "uses", target })),
});

describe("buildLineage", () => {
  it("walks dependencies and returns them deepest-first with the node last", () => {
    const nodes = [
      n("dashboard-farm", "printer-farm", ["service-api"]),
      n("service-api", "printer-api", ["container-118"]),
      n("container-118", "LXC 118"),
    ];
    expect(buildLineage(nodes, "dashboard-farm")).toEqual(["LXC 118", "printer-api", "printer-farm"]);
  });

  it("resolves a relationship target given as a title", () => {
    const nodes = [n("dashboard-farm", "printer-farm", ["printer-api"]), n("service-api", "printer-api")];
    expect(buildLineage(nodes, "dashboard-farm")).toEqual(["printer-api", "printer-farm"]);
  });

  it("returns just the node when it has no resolvable dependencies", () => {
    expect(buildLineage([n("vm-nuc", "pve · nuc-02", ["gone"])], "vm-nuc")).toEqual(["pve · nuc-02"]);
  });

  it("returns an empty array for an unknown node", () => {
    expect(buildLineage([n("a", "A")], "missing")).toEqual([]);
  });

  it("stops on a cycle instead of looping", () => {
    const nodes = [n("a", "A", ["b"]), n("b", "B", ["a"])];
    expect(buildLineage(nodes, "a")).toEqual(["B", "A"]);
  });

  it("caps the chain at four labels, keeping the node itself", () => {
    const nodes = [
      n("a", "A", ["b"]), n("b", "B", ["c"]), n("c", "C", ["d"]),
      n("d", "D", ["e"]), n("e", "E"),
    ];
    const out = buildLineage(nodes, "a");
    expect(out).toHaveLength(4);
    expect(out[out.length - 1]).toBe("A");
  });

  it("skips unresolvable targets in the relationship loop and continues with the next one", () => {
    // B's FIRST relationship target "gone" doesn't resolve to any node
    // B's SECOND relationship target "d" resolves successfully
    // The chain must skip "gone" and follow D
    const nodes = [
      n("b", "B", ["gone", "d"]),
      n("d", "D", []),
    ];
    expect(buildLineage(nodes, "b")).toEqual(["D", "B"]);
  });

  it("skips already-seen targets in the relationship loop and continues with the next one", () => {
    // B's FIRST relationship points back to A (which is in seen),
    // B's SECOND relationship points to a fresh node D.
    // The chain must skip A and follow D.
    const nodes = [
      n("a", "A", ["b"]),
      n("b", "B", ["a", "d"]),
      n("d", "D", []),
    ];
    expect(buildLineage(nodes, "a")).toEqual(["D", "B", "A"]);
  });

  it("prefers id over title when both match the same target string", () => {
    // "collision_id" is the id of node X and the title of node Y.
    // When resolving "collision_id", it should find X by id, not Y by title.
    const nodes = [
      n("app", "Application", ["collision_id"]),
      n("collision_id", "Primary node"),
      n("other", "collision_id"),
    ];
    expect(buildLineage(nodes, "app")).toEqual(["Primary node", "Application"]);
  });
});

describe("buildSurfaceLineage", () => {
  // agent-host's projector titles a dashboard node with its own id, so the
  // derived chain ends in "x1" while the registry calls the surface "Sales".
  // The ancestry is worth keeping; the last label is not.
  it("keeps the derived ancestry and replaces the last label with the registry title", () => {
    const nodes = [
      n("dashboard-x1", "x1", ["service-api"]),
      n("service-api", "printer-api", ["container-118"]),
      n("container-118", "LXC 118"),
    ];
    expect(buildSurfaceLineage(nodes, "x1", "Sales")).toEqual(["LXC 118", "printer-api", "Sales"]);
  });

  it("falls back to the registry title alone when the ontology has no node for the surface", () => {
    expect(buildSurfaceLineage([n("service-api", "printer-api")], "zz", "Spool log")).toEqual(["Spool log"]);
  });

  it("returns the title alone when the ontology is empty", () => {
    expect(buildSurfaceLineage([], "x1", "Sales")).toEqual(["Sales"]);
  });
});
