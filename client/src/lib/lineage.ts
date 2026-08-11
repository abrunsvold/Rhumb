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

// The breadcrumb for an ACTIVE SURFACE, as opposed to an ontology node.
// `agent-host/src/ontology/projector.ts` titles a dashboard node with its own
// id, so the derived chain ends in "x1" where the registry knows the surface as
// "Sales" — and the surface tab strip that used to carry that title is gone.
// Keep the derived ancestry and replace only the last label; when the ontology
// knows nothing about the surface, the title alone still names what is on
// screen rather than leaving the strip blank.
export function buildSurfaceLineage(
  nodes: OntologyNode[],
  surfaceId: string,
  title: string,
): string[] {
  const derived = buildLineage(nodes, `dashboard-${surfaceId}`);
  return derived.length > 0 ? [...derived.slice(0, -1), title] : [title];
}
