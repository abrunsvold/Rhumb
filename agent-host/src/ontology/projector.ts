import { rmSync } from "node:fs";
import { join } from "node:path";
import type { OntologyConfig, OntologyNode, Relationship } from "./types.js";
import type { NodeFacts } from "../infra/nodeFacts.js";
import type { DdlFacts } from "../infra/ddlFacts.js";
import { writeNode, listNodes } from "./vault.js";

export interface SyncDeps {
  config: Pick<OntologyConfig, "systemDir">;
  now: () => string;
  readDataSources: () => Array<{ id: string; type: string; mode: string }>;
  readServices: () => Array<{ id: string; name: string; containerId: number; host: string; port: number; status: string }>;
  readSurfaceIds: () => string[];
  readDataAudit: () => Array<{ surfaceId: string | null; source: string; op: { kind: string } }>;
  readInfraAudit: () => Array<{ ts: string; tool: string; input: Record<string, unknown>; decision: string }>;
  readNodeFacts: () => NodeFacts | null;
  readDdlFacts: () => DdlFacts | null;
}

// Frontmatter keys must stay plain: pool ids like "local-lvm" become storage_local_lvm.
const sanitizeKey = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
const round1 = (n: number) => String(Math.round(n * 10) / 10);

export function syncSystem(deps: SyncDeps): { added: number; updated: number; removed: number } {
  const ts = deps.now();
  const nodes = new Map<string, OntologyNode>();
  const createdBy: Relationship = { edge: "created-by", target: "agent" };
  const put = (n: Omit<OntologyNode, "managed" | "created" | "updated"> & { relationships: Relationship[] }) => {
    nodes.set(n.id, { ...n, managed: "system", created: ts, updated: ts });
  };

  // PVE node(s) first: the box roots the map. Placement comes from the cluster
  // resource mapping when present; a single-node cluster needs no mapping; and
  // on a multi-node cluster with no mapping we don't guess.
  const facts = deps.readNodeFacts();
  const nodeNames = new Set((facts?.nodes ?? []).map((n) => n.name));
  const singleNodeId = facts?.nodes.length === 1 ? `node-${facts.nodes[0].name}` : null;
  const runsOnNode: Relationship[] = singleNodeId ? [{ edge: "runs-on", target: singleNodeId }] : [];
  const placedOn = (name: string | undefined): Relationship[] =>
    name && nodeNames.has(name) ? [{ edge: "runs-on", target: `node-${name}` }] : runsOnNode;
  const containerRunsOn = (vmid: number) => placedOn(facts?.placements?.byVmid[String(vmid)]);
  const vmRunsOn = (vmName: string) => placedOn(facts?.placements?.byName[vmName]);
  for (const n of facts?.nodes ?? []) {
    const props: Record<string, string> = { status: n.status, address: n.address, factsAsOf: facts!.fetchedAt };
    if (n.pveVersion) props.pveVersion = n.pveVersion;
    if (n.cpuModel) props.cpuModel = n.cpuModel;
    if (typeof n.cores === "number") props.cores = String(n.cores);
    if (typeof n.memBytes === "number") props.memoryGb = round1(n.memBytes / 2 ** 30);
    if (typeof n.uptimeSec === "number") props.uptimeDays = round1(n.uptimeSec / 86400);
    for (const s of n.storage) props[`storage_${sanitizeKey(s.id)}`] = `${s.usedPct}% used`;
    put({ type: "node", id: `node-${n.name}`, title: n.name, props, relationships: [] });
  }

  const ddlFacts = deps.readDdlFacts();
  for (const s of deps.readDataSources()) {
    const props: Record<string, string> = { sourceType: s.type, mode: s.mode };
    const ddl = ddlFacts?.sources[s.id];
    if (ddl && !ddl.installed) props.ddlAudit = "not installed (pre-audit database)";
    if (ddl?.installed) {
      if (ddl.lastTag) props.lastDdl = `${ddl.lastTag} ${ddl.lastObject ?? "?"} by ${ddl.lastActor ?? "?"} @ ${ddl.lastTs ?? "?"}`;
      props.ddl7d = String(ddl.count7d ?? 0);
      props.ddlAsOf = ddlFacts!.fetchedAt;
    }
    put({ type: "datasource", id: `datasource-${s.id}`, title: s.id, props, relationships: [createdBy] });
  }
  for (const s of deps.readServices()) {
    put({ type: "container", id: `container-${s.containerId}`, title: `CT ${s.containerId}`, props: {}, relationships: [...containerRunsOn(s.containerId), createdBy] });
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
    put({ type: "vm", id: `vm-${name}`, title: name, props, relationships: [...vmRunsOn(name), createdBy] });
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
