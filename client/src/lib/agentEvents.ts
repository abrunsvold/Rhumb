import type { AgentEvent } from "./types";

export interface TranscriptMessage {
  kind: "text" | "result" | "error" | "tool" | "user";
  text: string;
  toolName?: string;
  toolInput?: unknown;
  attachments?: string[];
  // Optional stable identifier for list rendering. Nothing populates this
  // yet — reducer reshaping to assign ids is out of scope here — so
  // consumers fall back to index (`m.id ?? i`), matching current behavior.
  id?: string;
  // Sender login for user messages in a shared room. Rendering lands in plan 2.
  author?: string;
}

export interface AgentState {
  sessionId: string | null;
  slashCommands: string[];
  messages: TranscriptMessage[];
  // Room state, per session, fed by the session stream.
  presence: string[];
  queueDepth: number;
}

export const initialAgentState: AgentState = {
  sessionId: null,
  slashCommands: [],
  messages: [],
  presence: [],
  queueDepth: 0,
};

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
    case "session": {
      // The Agent SDK reports command names without the leading slash
      // ("compact", not "/compact"); the composer matches against a
      // slash-prefixed draft, so normalize here at ingestion.
      const cmds = event.slashCommands?.map((c) => (c.startsWith("/") ? c : `/${c}`));
      return {
        ...state,
        sessionId: event.sessionId,
        slashCommands: cmds ?? state.slashCommands,
      };
    }
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
    case "presence":
      return { ...state, presence: event.logins };
    case "queue":
      return { ...state, queueDepth: event.depth };
    // Task 5 gives `message` real behaviour; until then it stays inert so the
    // switch remains exhaustive.
    case "message":
      return state;
    default: {
      // Still fails the build if a future AgentEvent variant goes unhandled —
      // but never returns undefined at runtime, so a client older than the
      // host ignores unknown events instead of crashing the tab.
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}
