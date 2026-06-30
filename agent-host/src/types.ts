export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "result"; result: string; isError: boolean }
  | { type: "error"; message: string }
  | { type: "raw"; message: unknown };
