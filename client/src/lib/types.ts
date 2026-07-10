// Hand-mirrored in agent-host/src/types.ts (polyglot-by-contract; no shared
// package). Change both together.
export type AgentEvent =
  | { type: "session"; sessionId: string; slashCommands?: string[] }
  | { type: "result"; result: string; isError: boolean }
  | { type: "error"; message: string }
  | { type: "raw"; message: unknown };

export interface RegistryEntry {
  id: string;
  title: string;
  url: string;
  kind: string;
  created: string;
  updated: string;
}

export interface RegistrySnapshot {
  surfaces: RegistryEntry[];
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  preview: string;
  archived: boolean;
}

// Mirrors agent-host/src/ontology/types.ts (polyglot by contract, like AgentEvent).
export interface OntologyNode {
  type: string;
  id: string;
  title: string;
  managed: "system" | "domain";
  created?: string;
  updated?: string;
  props: Record<string, string>;
  relationships: { edge: string; target: string }[];
}

export interface OntologySnapshot {
  nodes: OntologyNode[];
  syncedAt: string | null;
  syncError: string | null;
}
