import { describe, it, expect } from "vitest";
import { flattenNodes, filterNodes, registryIdFor } from "../src/lib/ontologyStore";
import type { OntologyNode } from "../src/lib/types";

const n = (over: Partial<OntologyNode>): OntologyNode => ({
  type: "service", id: "service-x", title: "X", managed: "system",
  props: {}, relationships: [], ...over,
});

const nRel = (id: string, type: string, rels: string[] = []): OntologyNode => ({
  type, id, title: id, managed: "system", props: {},
  relationships: rels.map((target) => ({ edge: "uses", target })),
});

describe("flattenNodes", () => {
  it("puts dashboards at depth 0 with their dependencies nested under them", () => {
    const out = flattenNodes([
      nRel("dashboard-farm", "dashboard", ["service-api"]),
      nRel("service-api", "service", ["container-118"]),
      nRel("container-118", "container"),
    ]);
    expect(out.map((r) => [r.node.id, r.depth])).toEqual([
      ["dashboard-farm", 0],
      ["service-api", 1],
      ["container-118", 2],
    ]);
  });

  it("lists nodes no dashboard reaches at depth 0, after the dashboards", () => {
    const out = flattenNodes([
      nRel("dashboard-farm", "dashboard"),
      nRel("vm-nuc", "vm"),
    ]);
    expect(out.map((r) => [r.node.id, r.depth])).toEqual([
      ["dashboard-farm", 0],
      ["vm-nuc", 0],
    ]);
  });

  it("emits each node once even when two dashboards share a dependency", () => {
    const out = flattenNodes([
      nRel("dashboard-a", "dashboard", ["datasource-pg"]),
      nRel("dashboard-b", "dashboard", ["datasource-pg"]),
      nRel("datasource-pg", "datasource"),
    ]);
    expect(out.filter((r) => r.node.id === "datasource-pg")).toHaveLength(1);
  });

  it("terminates on a relationship cycle", () => {
    const out = flattenNodes([
      nRel("dashboard-a", "dashboard", ["service-x"]),
      nRel("service-x", "service", ["dashboard-a"]),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("filterNodes", () => {
  const nodes = [
    n({ id: "service-poller", title: "Print poller", props: { host: "192.168.1.95" } }),
    n({ id: "service-api", title: "API" }),
  ];
  it("matches id, title, and prop values case-insensitively", () => {
    expect(filterNodes(nodes, "POLLER")).toHaveLength(1);
    expect(filterNodes(nodes, "192.168")).toHaveLength(1);
    expect(filterNodes(nodes, "print")).toHaveLength(1);
  });
  it("empty query returns everything", () => {
    expect(filterNodes(nodes, "  ")).toHaveLength(2);
  });
});

describe("registryIdFor", () => {
  it("maps dashboard nodes to their registry id and others to null", () => {
    expect(registryIdFor(n({ type: "dashboard", id: "dashboard-spools" }))).toBe("spools");
    expect(registryIdFor(n({ type: "service", id: "service-x" }))).toBeNull();
  });
});
