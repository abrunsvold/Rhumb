// Hand-mirrored in client/src/lib/types.ts (polyglot-by-contract; no shared
// package). Change both together.
export type AgentEvent =
  | { type: "session"; sessionId: string; slashCommands?: string[] }
  | { type: "result"; result: string; isError: boolean }
  | { type: "error"; message: string }
  | { type: "raw"; message: unknown }
  // Room events. A session is shared, so the human message is broadcast to
  // every watcher rather than echoed locally by whoever typed it.
  | { type: "message"; author: string; text: string; ts: string; turnId?: string }
  | { type: "queue"; depth: number }
  | { type: "presence"; logins: string[] };

export interface TranscriptMessage {
  kind: "text" | "result" | "error" | "tool" | "user";
  text: string;
  toolName?: string;
  toolInput?: unknown;
  // Sender login, recovered from the `[from: ...]` envelope on user turns.
  // Absent for agent output and for transcripts written before rooms existed.
  author?: string;
}
