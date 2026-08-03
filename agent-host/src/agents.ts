import { readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./fsAtomic.js";
import type { BackendId } from "./backends/types.js";

/** One agent principal. `agentId` is Rhumb-owned and durable; `nativeId` is
 *  the backend's disposable handle, bound at spawn. Keeping them distinct is
 *  what lets a mngr fork inherit no trust. */
export interface AgentRecord {
  agentId: string;
  nativeId: string | null;
  backend: BackendId;
  name: string;
  createdAt: string;
  lastActiveAt: string;
  status: "active" | "stopped";
}

export interface AgentRegistry {
  create(name: string, backend: BackendId): AgentRecord;
  get(agentId: string): AgentRecord | undefined;
  bind(agentId: string, nativeId: string): boolean;
  touch(agentId: string): boolean;
  markStopped(agentId: string): boolean;
  list(): AgentRecord[];
}

function load(indexPath: string): AgentRecord[] {
  try {
    const raw = JSON.parse(readFileSync(indexPath, "utf8"));
    return Array.isArray(raw) ? (raw as AgentRecord[]) : [];
  } catch {
    // Missing or corrupt: start empty, same posture as sessions.ts.
    return [];
  }
}

export function createAgentRegistry(deps: {
  indexPath: string;
  now: () => string;
  id: () => string;
}): AgentRegistry {
  const records = load(deps.indexPath);
  const persist = () => atomicWriteFileSync(deps.indexPath, JSON.stringify(records, null, 2));

  return {
    create(name, backend) {
      const stamp = deps.now();
      const rec: AgentRecord = {
        agentId: deps.id(),
        nativeId: null,
        backend,
        name,
        createdAt: stamp,
        lastActiveAt: stamp,
        status: "active",
      };
      records.push(rec);
      persist();
      return rec;
    },
    get(agentId) {
      const rec = records.find((r) => r.agentId === agentId);
      return rec ? { ...rec } : undefined;
    },
    bind(agentId, nativeId) {
      const rec = records.find((r) => r.agentId === agentId);
      if (!rec) return false;
      rec.nativeId = nativeId;
      rec.lastActiveAt = deps.now();
      persist();
      return true;
    },
    touch(agentId) {
      const rec = records.find((r) => r.agentId === agentId);
      if (!rec) return false;
      rec.lastActiveAt = deps.now();
      persist();
      return true;
    },
    markStopped(agentId) {
      const rec = records.find((r) => r.agentId === agentId);
      if (!rec) return false;
      rec.status = "stopped";
      persist();
      return true;
    },
    list() {
      return records.map((r) => ({ ...r }));
    },
  };
}
