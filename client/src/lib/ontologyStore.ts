import type { OntologyNode } from "./types";

// Fixed sidebar order — the ontology's type scheme IS the nav taxonomy.
const SECTIONS: { type: string; label: string }[] = [
  { type: "node", label: "Nodes" },
  { type: "dashboard", label: "Dashboards" },
  { type: "service", label: "Services" },
  { type: "container", label: "Containers" },
  { type: "datasource", label: "Data sources" },
  { type: "vm", label: "VMs" },
];
const DOMAIN_LABEL = "Domain";

export function groupNodes(nodes: OntologyNode[]): { type: string; label: string; nodes: OntologyNode[] }[] {
  const known = new Set(SECTIONS.map((s) => s.type));
  const groups = SECTIONS.map((s) => ({
    ...s,
    nodes: nodes.filter((n) => n.type === s.type),
  }));
  // entity nodes plus anything with a type this client doesn't know yet
  groups.push({ type: "entity", label: DOMAIN_LABEL, nodes: nodes.filter((n) => !known.has(n.type)) });
  return groups.filter((g) => g.nodes.length > 0);
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
