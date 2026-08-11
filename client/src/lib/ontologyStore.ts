import type { OntologyNode } from "./types";

// Relationship targets are written by the agent and may be an id or a title,
// so resolve on either. An unresolvable target is simply not a tree edge.
function resolve(nodes: OntologyNode[], target: string): OntologyNode | undefined {
  return nodes.find((n) => n.id === target) ?? nodes.find((n) => n.title === target);
}

// Dashboards are the roots — they are the things an operator opens. Everything
// they depend on nests beneath them; whatever no dashboard reaches is listed
// flat afterwards, which is how an orphaned host shows up at all.
export function flattenNodes(nodes: OntologyNode[]): { node: OntologyNode; depth: number }[] {
  const out: { node: OntologyNode; depth: number }[] = [];
  const emitted = new Set<string>();

  function walk(node: OntologyNode, depth: number, seen: Set<string>) {
    if (emitted.has(node.id) || seen.has(node.id) || depth > 6) return;
    emitted.add(node.id);
    out.push({ node, depth });
    const next = new Set(seen).add(node.id);
    for (const rel of node.relationships) {
      const child = resolve(nodes, rel.target);
      if (child) walk(child, depth + 1, next);
    }
  }

  for (const node of nodes.filter((n) => n.type === "dashboard")) walk(node, 0, new Set());
  for (const node of nodes) if (!emitted.has(node.id)) walk(node, 0, new Set());
  return out;
}

export function filterNodes(nodes: OntologyNode[], query: string): OntologyNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  return nodes.filter(
    (n) =>
      n.id.toLowerCase().includes(q) ||
      n.title.toLowerCase().includes(q) ||
      Object.values(n.props).some((v) => v.toLowerCase().includes(q)),
  );
}

export function registryIdFor(node: OntologyNode): string | null {
  return node.type === "dashboard" ? node.id.replace(/^dashboard-/, "") : null;
}
