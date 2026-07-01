import { describe, it, expect } from "vitest";
import { buildGraph } from "../src/ontology/graph.js";
import type { OntologyNode } from "../src/ontology/types.js";

const n = (id: string, type: string, rels: [string, string][] = []): OntologyNode => ({
  type, id, title: id, managed: "system", props: {},
  relationships: rels.map(([edge, target]) => ({ edge, target })),
});

const nodes: OntologyNode[] = [
  n("service-demo", "service", [["runs-on", "container-105"]]),
  n("container-105", "container"),
  { ...n("customer-1", "entity", [["stored-in", "datasource-ops"]]), managed: "domain" },
  n("datasource-ops", "datasource"),
];

describe("buildGraph", () => {
  it("getNode + nodesByType", () => {
    const g = buildGraph(nodes);
    expect(g.getNode("container-105")?.type).toBe("container");
    expect(g.getNode("nope")).toBeUndefined();
    expect(g.nodesByType("service").map((x) => x.id)).toEqual(["service-demo"]);
  });

  it("neighbors out/in/both", () => {
    const g = buildGraph(nodes);
    // what does service-demo run on (out)
    expect(g.neighbors("service-demo", { edge: "runs-on", direction: "out" }).map((x) => x.node.id)).toEqual(["container-105"]);
    // what runs on container-105 (in)
    expect(g.neighbors("container-105", { edge: "runs-on", direction: "in" }).map((x) => x.node.id)).toEqual(["service-demo"]);
    // reverse cross-layer: what is stored in datasource-ops (in-edges of stored-in)
    expect(g.neighbors("datasource-ops", { direction: "in" }).map((x) => x.node.id)).toEqual(["customer-1"]);
    // both directions default
    expect(g.neighbors("container-105").map((x) => x.node.id)).toEqual(["service-demo"]);
  });

  it("ignores edges to unknown nodes", () => {
    const g = buildGraph([n("a", "entity", [["relates-to", "ghost"]])]);
    expect(g.neighbors("a")).toEqual([]);
  });
});
