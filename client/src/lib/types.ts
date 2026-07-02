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
