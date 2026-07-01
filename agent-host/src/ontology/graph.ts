import type { OntologyNode } from "./types.js";

interface Edge { from: string; edge: string; to: string }
export interface Graph {
  getNode(id: string): OntologyNode | undefined;
  nodesByType(type: string): OntologyNode[];
  neighbors(id: string, opts?: { edge?: string; direction?: "out" | "in" | "both" }): { edge: string; node: OntologyNode; direction: "out" | "in" }[];
}

export function buildGraph(nodes: OntologyNode[]): Graph {
  const byId = new Map<string, OntologyNode>();
  for (const n of nodes) byId.set(n.id, n);
  const edges: Edge[] = [];
  for (const n of nodes) for (const r of n.relationships) edges.push({ from: n.id, edge: r.edge, to: r.target });

  return {
    getNode: (id) => byId.get(id),
    nodesByType: (type) => nodes.filter((n) => n.type === type),
    neighbors(id, opts = {}) {
      const dir = opts.direction ?? "both";
      const out: { edge: string; node: OntologyNode; direction: "out" | "in" }[] = [];
      for (const e of edges) {
        if (opts.edge && e.edge !== opts.edge) continue;
        if ((dir === "out" || dir === "both") && e.from === id) {
          const node = byId.get(e.to);
          if (node) out.push({ edge: e.edge, node, direction: "out" });
        }
        if ((dir === "in" || dir === "both") && e.to === id) {
          const node = byId.get(e.from);
          if (node) out.push({ edge: e.edge, node, direction: "in" });
        }
      }
      return out;
    },
  };
}
