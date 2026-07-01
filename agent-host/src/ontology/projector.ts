import { rmSync } from "node:fs";
import { join } from "node:path";
import type { OntologyConfig, OntologyNode, Relationship } from "./types.js";
import { writeNode, listNodes } from "./vault.js";

export interface SyncDeps {
  config: Pick<OntologyConfig, "systemDir">;
  now: () => string;
  readDataSources: () => Array<{ id: string; type: string; mode: string }>;
  readServices: () => Array<{ id: string; name: string; containerId: number; host: string; port: number; status: string }>;
  readSurfaceIds: () => string[];
  readDataAudit: () => Array<{ surfaceId: string | null; source: string; op: { kind: string } }>;
  readInfraAudit: () => Array<{ ts: string; tool: string; input: Record<string, unknown>; decision: string }>;
}

export function syncSystem(deps: SyncDeps): { added: number; updated: number; removed: number } {
  const ts = deps.now();
  const nodes = new Map<string, OntologyNode>();
  const createdBy: Relationship = { edge: "created-by", target: "agent" };
  const put = (n: Omit<OntologyNode, "managed" | "created" | "updated"> & { relationships: Relationship[] }) => {
    nodes.set(n.id, { ...n, managed: "system", created: ts, updated: ts });
  };

  for (const s of deps.readDataSources()) {
    put({ type: "datasource", id: `datasource-${s.id}`, title: s.id, props: { sourceType: s.type, mode: s.mode }, relationships: [createdBy] });
  }
  for (const s of deps.readServices()) {
    put({ type: "container", id: `container-${s.containerId}`, title: `CT ${s.containerId}`, props: {}, relationships: [createdBy] });
    put({
      type: "service", id: `service-${s.id}`, title: s.name,
      props: { host: s.host, port: String(s.port), status: s.status },
      relationships: [{ edge: "runs-on", target: `container-${s.containerId}` }, createdBy],
    });
  }
  for (const id of deps.readSurfaceIds()) {
    put({ type: "dashboard", id: `dashboard-${id}`, title: id, props: {}, relationships: [createdBy] });
  }
  // reads-from / writes-to edges from the data audit (only when both nodes exist)
  for (const a of deps.readDataAudit()) {
    if (!a.surfaceId) continue;
    const dash = nodes.get(`dashboard-${a.surfaceId}`);
    const dsId = `datasource-${a.source}`;
    if (!dash || !nodes.has(dsId)) continue;
    const edge = a.op.kind === "select" ? "reads-from" : "writes-to";
    if (!dash.relationships.some((r) => r.edge === edge && r.target === dsId)) {
      dash.relationships.push({ edge, target: dsId });
    }
  }
  // vm nodes: create-only best-effort from approved create_vm (audit lacks the resulting vmid).
  for (const a of deps.readInfraAudit()) {
    if (a.decision !== "approved" || a.tool !== "mcp__infra__create_vm") continue;
    const name = typeof a.input.name === "string" ? a.input.name : undefined;
    if (!name) continue;
    const props: Record<string, string> = {};
    if (typeof a.input.cores === "number") props.cores = String(a.input.cores);
    if (typeof a.input.memory === "number") props.memory = String(a.input.memory);
    put({ type: "vm", id: `vm-${name}`, title: name, props, relationships: [createdBy] });
  }

  const desired = [...nodes.values()];
  let added = 0;
  const existing = new Set(listNodes(deps.config.systemDir).map((n) => n.id));
  for (const n of desired) { if (!existing.has(n.id)) added++; writeNode(deps.config.systemDir, n); }
  let removed = 0;
  for (const id of existing) {
    if (!nodes.has(id)) { rmSync(join(deps.config.systemDir, `${id}.md`), { force: true }); removed++; }
  }
  return { added, updated: desired.length - added, removed };
}
