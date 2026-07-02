import {
  initialAgentState, reduceAgent, appendUserMessage,
  type AgentState, type TranscriptMessage,
} from "./agentEvents";
import type { AgentEvent } from "./types";

export interface TabState {
  key: string;
  title: string;
  agent: AgentState;
  openTurns: number;
  unread: boolean;
  stale: boolean;
  historyNotice: boolean;
}

export interface ChatStore {
  tabs: TabState[];
  activeKey: string | null;
}

export const emptyStore: ChatStore = { tabs: [], activeKey: null };

function mapTab(s: ChatStore, key: string, fn: (t: TabState) => TabState): ChatStore {
  return { ...s, tabs: s.tabs.map((t) => (t.key === key ? fn(t) : t)) };
}

export function openTab(
  s: ChatStore,
  key: string,
  title: string,
  seed?: TranscriptMessage[],
): ChatStore {
  if (s.tabs.some((t) => t.key === key)) return focusTab(s, key);
  // Real session keys carry their id into AgentState so resumed sends
  // continue the session instead of starting a new one; drafts stay null
  // until their first session event.
  const sessionId = key.startsWith("draft:") ? null : key;
  const tab: TabState = {
    key,
    title,
    agent: { ...initialAgentState, sessionId, messages: seed ?? [] },
    openTurns: 0,
    unread: false,
    stale: false,
    historyNotice: false,
  };
  return { tabs: [...s.tabs, tab], activeKey: key };
}

export function closeTab(s: ChatStore, key: string): ChatStore {
  const idx = s.tabs.findIndex((t) => t.key === key);
  if (idx === -1) return s;
  const tabs = s.tabs.filter((t) => t.key !== key);
  const activeKey =
    s.activeKey === key ? (tabs[idx - 1]?.key ?? tabs[idx]?.key ?? null) : s.activeKey;
  return { tabs, activeKey };
}

export function focusTab(s: ChatStore, key: string): ChatStore {
  return { ...mapTab(s, key, (t) => ({ ...t, unread: false })), activeKey: key };
}

export function reduceEvent(s: ChatStore, key: string, e: AgentEvent): ChatStore {
  return mapTab(s, key, (t) => ({
    ...t,
    agent: reduceAgent(t.agent, e),
    unread: t.unread || s.activeKey !== key,
  }));
}

export function addUserMessage(
  s: ChatStore,
  key: string,
  text: string,
  attachments?: string[],
): ChatStore {
  return mapTab(s, key, (t) => ({ ...t, agent: appendUserMessage(t.agent, text, attachments) }));
}

export function bumpTurns(s: ChatStore, key: string, delta: 1 | -1): ChatStore {
  return mapTab(s, key, (t) => ({ ...t, openTurns: Math.max(0, t.openTurns + delta) }));
}

export function promoteDraft(s: ChatStore, draftKey: string, sessionId: string): ChatStore {
  if (s.tabs.some((t) => t.key === sessionId)) return closeTab(s, draftKey);
  return {
    tabs: s.tabs.map((t) =>
      t.key === draftKey ? { ...t, key: sessionId, agent: { ...t.agent, sessionId } } : t,
    ),
    activeKey: s.activeKey === draftKey ? sessionId : s.activeKey,
  };
}

export function setStale(s: ChatStore, key: string, stale: boolean): ChatStore {
  return mapTab(s, key, (t) => ({ ...t, stale }));
}

export function setTitle(s: ChatStore, key: string, title: string): ChatStore {
  return mapTab(s, key, (t) => ({ ...t, title }));
}

export function setHistoryNotice(s: ChatStore, key: string): ChatStore {
  return mapTab(s, key, (t) => ({ ...t, historyNotice: true }));
}
