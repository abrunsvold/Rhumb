import type { AgentEvent } from "./types";

export interface TranscriptMessage {
  kind: "text" | "result" | "error" | "tool" | "user";
  text: string;
  toolName?: string;
  toolInput?: unknown;
  attachments?: string[];
}

export interface AgentState {
  sessionId: string | null;
  slashCommands: string[];
  messages: TranscriptMessage[];
}

export const initialAgentState: AgentState = { sessionId: null, slashCommands: [], messages: [] };

export function appendUserMessage(state: AgentState, text: string, attachments?: string[]): AgentState {
  const msg: TranscriptMessage =
    attachments && attachments.length > 0 ? { kind: "user", text, attachments } : { kind: "user", text };
  return { ...state, messages: [...state.messages, msg] };
}

function extractFromRaw(message: unknown): TranscriptMessage[] {
  if (typeof message !== "object" || message === null) return [];
  const m = message as Record<string, unknown>;
  if (m.type !== "assistant") return [];
  const inner = m.message as Record<string, unknown> | undefined;
  const content = inner?.content;
  if (!Array.isArray(content)) return [];
  const out: TranscriptMessage[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ kind: "text", text: b.text });
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      out.push({ kind: "tool", text: b.name, toolName: b.name, toolInput: b.input });
    }
  }
  return out;
}

export function reduceAgent(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case "session":
      return {
        ...state,
        sessionId: event.sessionId,
        slashCommands: event.slashCommands ?? state.slashCommands,
      };
    case "result":
      return {
        ...state,
        messages: [
          ...state.messages,
          { kind: event.isError ? "error" : "result", text: event.result },
        ],
      };
    case "error":
      return { ...state, messages: [...state.messages, { kind: "error", text: event.message }] };
    case "raw": {
      const extracted = extractFromRaw(event.message);
      if (extracted.length === 0) return state;
      return { ...state, messages: [...state.messages, ...extracted] };
    }
  }
}
