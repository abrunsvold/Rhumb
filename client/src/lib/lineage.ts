import type { OntologyNode } from "./types";

const MAX_LABELS = 4;

function resolve(nodes: OntologyNode[], target: string): OntologyNode | undefined {
  return nodes.find((n) => n.id === target) ?? nodes.find((n) => n.title === target);
}

// The breadcrumb reads bottom-up: the thing everything rests on, through to
// the surface itself. Follows the FIRST resolvable relationship at each hop —
// a node with several dependencies has no single lineage, and picking one is
// better than rendering a graph in a 40px strip.
export function buildLineage(nodes: OntologyNode[], nodeId: string): string[] {
  const start = nodes.find((n) => n.id === nodeId);
  if (!start) return [];
  const chain: string[] = [start.title];
  const seen = new Set<string>([start.id]);
  let cur = start;
  while (chain.length < MAX_LABELS) {
    let next: OntologyNode | undefined;
    for (const rel of cur.relationships) {
      const cand = resolve(nodes, rel.target);
      if (cand && !seen.has(cand.id)) {
        next = cand;
        break;
      }
    }
    if (!next) break;
    seen.add(next.id);
    chain.push(next.title);
    cur = next;
  }
  return chain.reverse();
}
