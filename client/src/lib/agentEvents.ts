import type { AgentEvent } from "./types";
import { splitAttachments } from "./attachments";

export interface TranscriptMessage {
  kind: "text" | "result" | "error" | "tool" | "user";
  text: string;
  toolName?: string;
  toolInput?: unknown;
  attachments?: string[];
  // Stable identifier for list rendering. User messages carry the turnId that
  // produced them, which is also what reconciles the sender's optimistic entry
  // against the server's broadcast; agent output carries none, so consumers
  // still fall back to index (`m.id ?? i`).
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

export function appendUserMessage(
  state: AgentState,
  text: string,
  attachments?: string[],
  id?: string,
): AgentState {
  const msg: TranscriptMessage = {
    kind: "user",
    text,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(id ? { id } : {}),
  };
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
    case "message": {
      // Upsert, not append. The sender receives its own message on both the
      // turn stream and the session stream, and it already rendered an
      // optimistic entry under this turnId.
      const idx = event.turnId
        ? state.messages.findIndex((m) => m.id === event.turnId)
        : -1;
      if (idx !== -1) {
        // Adopt only the author. The wire text is the prompt, which has the
        // attachment paths appended — taking it would replace the sender's
        // chips with a raw path line.
        const messages = state.messages.slice();
        messages[idx] = { ...messages[idx], author: event.author };
        return { ...state, messages };
      }
      const { text, attachments } = splitAttachments(event.text);
      const msg: TranscriptMessage = {
        kind: "user",
        text,
        author: event.author,
        ...(event.turnId ? { id: event.turnId } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      return { ...state, messages: [...state.messages, msg] };
    }
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
