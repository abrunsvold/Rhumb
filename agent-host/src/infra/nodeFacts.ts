import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../fsAtomic.js";
import type { PveCall } from "./proxmox.js";

export interface NodeFactEntry {
  name: string;
  status: string;
  uptimeSec?: number;
  cores?: number;
  memBytes?: number;
  pveVersion?: string;
  cpuModel?: string;
  address: string;
  storage: Array<{ id: string; usedPct: number }>;
}

export interface NodeFacts {
  fetchedAt: string;
  nodes: NodeFactEntry[];
  // Guest→node placement from /cluster/resources: containers resolve by vmid,
  // VMs (projected by name from the audit) by name. Absent when the call fails.
  placements?: { byVmid: Record<string, string>; byName: Record<string, string> };
}

export function createNodeFactsRefresher(deps: {
  call: PveCall;
  address: string;
  path: string;
  now: () => string;
}): () => Promise<NodeFacts> {
  return async function refresh(): Promise<NodeFacts> {
    const raw = (await deps.call("GET", "/nodes")) as Array<{
      node: string; status?: string; uptime?: number; maxcpu?: number; maxmem?: number;
    }>;
    const nodes: NodeFactEntry[] = [];
    for (const n of raw) {
      const entry: NodeFactEntry = { name: n.node, status: n.status ?? "unknown", address: deps.address, storage: [] };
      if (typeof n.uptime === "number") entry.uptimeSec = n.uptime;
      if (typeof n.maxcpu === "number") entry.cores = n.maxcpu;
      if (typeof n.maxmem === "number") entry.memBytes = n.maxmem;
      // Sub-calls degrade per-node: a node missing its version props is still a node.
      try {
        const st = (await deps.call("GET", `/nodes/${n.node}/status`)) as {
          pveversion?: string; cpuinfo?: { model?: string };
        };
        if (st.pveversion) entry.pveVersion = st.pveversion;
        if (st.cpuinfo?.model) entry.cpuModel = st.cpuinfo.model;
      } catch { /* degrade */ }
      try {
        const stor = (await deps.call("GET", `/nodes/${n.node}/storage`)) as Array<{
          storage: string; used?: number; total?: number;
        }>;
        entry.storage = stor
          .filter((s) => typeof s.total === "number" && s.total > 0)
          .map((s) => ({ id: s.storage, usedPct: Math.round((100 * (s.used ?? 0)) / (s.total as number)) }));
      } catch { /* degrade */ }
      nodes.push(entry);
    }
    const facts: NodeFacts = { fetchedAt: deps.now(), nodes };
    try {
      const resources = (await deps.call("GET", "/cluster/resources?type=vm")) as Array<{
        vmid?: number; node?: string; name?: string;
      }>;
      const byVmid: Record<string, string> = {};
      const byName: Record<string, string> = {};
      for (const r of resources) {
        if (typeof r.vmid !== "number" || typeof r.node !== "string") continue;
        byVmid[String(r.vmid)] = r.node;
        if (typeof r.name === "string" && r.name) byName[r.name] = r.node;
      }
      facts.placements = { byVmid, byName };
    } catch { /* degrade: single-node fallback still applies */ }
    atomicWriteFileSync(deps.path, JSON.stringify(facts, null, 2));
    return facts;
  };
}

export function readNodeFactsFile(path: string): NodeFacts | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as NodeFacts;
    return Array.isArray(parsed?.nodes) && typeof parsed?.fetchedAt === "string" ? parsed : null;
  } catch {
    return null;
  }
}
