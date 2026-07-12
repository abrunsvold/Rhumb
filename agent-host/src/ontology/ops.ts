import { join } from "node:path";
import { existsSync } from "node:fs";
import type { OntologyNode } from "./types.js";
import { readNode, writeNode, listNodes } from "./vault.js";
import { buildGraph } from "./graph.js";

const ID = /^[A-Za-z0-9._-]+$/;
const RESERVED_PREFIX = /^(datasource|service|container|vm|dashboard)-/;
const hasNewline = (s: string) => /[\r\n]/.test(s);

export type OntologyQuery =
  | { kind: "node"; id: string }
  | { kind: "type"; type: string }
  | { kind: "neighbors"; id: string; edge?: string; direction?: "out" | "in" | "both" };

export interface OntologyOps {
  sync(): { added: number; updated: number; removed: number };
  list(): OntologyNode[];
  status(): { syncedAt: string | null; syncError: string | null };
  query(q: OntologyQuery): unknown;
  upsert(node: { id: string; title: string; subtype?: string; props?: Record<string, string> }): OntologyNode;
  link(from: string, edge: string, to: string): OntologyNode;
}

export interface OntologyOpsDeps {
  systemDir: string;
  domainDir: string;
  now: () => string;
  sync: () => { added: number; updated: number; removed: number };
}

export const ONTOLOGY_TOOL_NAMES: readonly string[] = [
  "mcp__ontology__sync", "mcp__ontology__query", "mcp__ontology__upsert_node", "mcp__ontology__link",
];

export function createOntologyOps(deps: OntologyOpsDeps): OntologyOps {
  const allNodes = () => [...listNodes(deps.systemDir), ...listNodes(deps.domainDir)];
  const domainPath = (id: string) => join(deps.domainDir, `${id}.md`);
  let syncedAt: string | null = null;
  let syncError: string | null = null;

  return {
    sync() {
      try {
        const r = deps.sync();
        syncedAt = deps.now();
        syncError = null;
        return r;
      } catch (e) {
        syncError = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },
    list: allNodes,
    status: () => ({ syncedAt, syncError }),
    query(q) {
      const g = buildGraph(allNodes());
      if (q.kind === "node") return g.getNode(q.id) ?? null;
      if (q.kind === "type") return g.nodesByType(q.type);
      return g.neighbors(q.id, { edge: q.edge, direction: q.direction });
    },
    upsert(input) {
      if (!ID.test(input.id)) throw new Error(`invalid node id: ${input.id}`);
      if (RESERVED_PREFIX.test(input.id)) {
        throw new Error(`node id "${input.id}" uses a reserved system prefix (datasource-/service-/container-/vm-/dashboard-); choose a domain id`);
      }
      if (hasNewline(input.title)) throw new Error("node title must not contain newlines");
      const existing = existsSync(domainPath(input.id)) ? readNode(domainPath(input.id)) : null;
      const ts = deps.now();
      const props = { ...(input.subtype ? { subtype: input.subtype } : {}), ...(input.props ?? {}) };
      for (const [k, v] of Object.entries(props)) {
        if (hasNewline(k) || hasNewline(v)) throw new Error(`prop "${k}" must not contain newlines`);
      }
      const node: OntologyNode = {
        type: "entity", id: input.id, title: input.title, managed: "domain",
        created: existing?.created ?? ts, updated: ts, props,
        relationships: existing?.relationships ?? [],
      };
      writeNode(deps.domainDir, node);
      return node;
    },
    link(from, edge, to) {
      if (!ID.test(from) || !ID.test(to)) throw new Error("invalid node id");
      // the edge is written on `from`'s file, so `from` must be a domain (agent-owned) node
      if (!existsSync(domainPath(from))) {
        throw new Error(`link source "${from}" must be a domain node — author cross-layer edges from the domain side`);
      }
      const node = readNode(domainPath(from));
      if (!node) throw new Error(`domain node not found: ${from}`);
      if (!node.relationships.some((r) => r.edge === edge && r.target === to)) {
        node.relationships.push({ edge, target: to });
        node.updated = deps.now();
        writeNode(deps.domainDir, node);
      }
      return node;
    },
  };
}
