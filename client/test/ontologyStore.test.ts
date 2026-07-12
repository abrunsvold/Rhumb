import { describe, it, expect } from "vitest";
import { groupNodes, filterNodes, registryIdFor } from "../src/lib/ontologyStore";
import type { OntologyNode } from "../src/lib/types";

const n = (over: Partial<OntologyNode>): OntologyNode => ({
  type: "service", id: "service-x", title: "X", managed: "system",
  props: {}, relationships: [], ...over,
});

describe("groupNodes", () => {
  it("puts the Nodes section first — the box roots the map", () => {
    const groups = groupNodes([
      n({ type: "dashboard", id: "dashboard-d1", title: "d1" }),
      n({ type: "node", id: "node-MicroPX", title: "MicroPX" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Nodes", "Dashboards"]);
  });

  it("groups by type in fixed order and omits empty sections", () => {
    const groups = groupNodes([
      n({ type: "datasource", id: "datasource-a", title: "a" }),
      n({ type: "dashboard", id: "dashboard-d1", title: "d1" }),
      n({ type: "service", id: "service-s", title: "S" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Dashboards", "Services", "Data sources"]);
  });

  it("folds unknown types and domain entities into Domain", () => {
    const groups = groupNodes([
      n({ type: "entity", id: "customer-1", title: "Acme", managed: "domain" }),
      n({ type: "weird", id: "w-1", title: "w" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Domain");
    expect(groups[0].nodes.map((x) => x.id)).toEqual(["customer-1", "w-1"]);
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
