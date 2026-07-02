import { useEffect, useRef, useState } from "react";
import {
  emptyStore, openTab, closeTab, focusTab, reduceEvent, addUserMessage,
  bumpTurns, promoteDraft, setStale, setTitle, setHistoryNotice,
  type ChatStore,
} from "../lib/chatStore";
import {
  openAgentStream, openSessionStream, sendMessage, uploadFile, getTranscript,
} from "../lib/tauri";
import type { AgentEvent } from "../lib/types";
import type { StagedFile } from "../components/Composer";

export interface ChatSessionsApi {
  store: ChatStore;
  openSession(meta: { id: string; title: string }): Promise<void>;
  newDraft(): void;
  close(key: string): void;
  focus(key: string): void;
  send(key: string, text: string, files: StagedFile[]): Promise<boolean>;
  setTabTitle(key: string, title: string): void;
}

const RETRY_DELAYS = [2000, 5000, 15000];

export function useChatSessions(agentBase: string): ChatSessionsApi {
  const [store, setStore] = useState<ChatStore>(emptyStore);
  const storeRef = useRef(store);
  storeRef.current = store;

  const sessionStops = useRef(new Map<string, () => void>());
  const turnStops = useRef(new Map<string, () => void>());
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const retryCount = useRef(new Map<string, number>());
  // key under which each turn's events should reduce (draft keys re-point on promote)
  const turnKey = useRef(new Map<string, string>());

  useEffect(() => {
    const sessions = sessionStops.current;
    const turns = turnStops.current;
    const timers = retryTimers.current;
    return () => {
      for (const stop of sessions.values()) stop();
      for (const stop of turns.values()) stop();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  function attachSessionStream(sessionId: string) {
    sessionStops.current.get(sessionId)?.();
    const stop = openSessionStream(agentBase, sessionId, (raw) => {
      const e = raw as { type?: string };
      if (e?.type === "stream_closed") {
        setStore((s) => setStale(s, sessionId, true));
        const n = retryCount.current.get(sessionId) ?? 0;
        const delay = RETRY_DELAYS[Math.min(n, RETRY_DELAYS.length - 1)];
        retryCount.current.set(sessionId, n + 1);
        retryTimers.current.set(
          sessionId,
          setTimeout(() => {
            if (storeRef.current.tabs.some((t) => t.key === sessionId)) {
              attachSessionStream(sessionId);
            }
          }, delay),
        );
        return;
      }
      retryCount.current.set(sessionId, 0);
      setStore((s) => reduceEvent(setStale(s, sessionId, false), sessionId, raw as AgentEvent));
    });
    sessionStops.current.set(sessionId, stop);
  }

  async function openSession(meta: { id: string; title: string }) {
    if (storeRef.current.tabs.some((t) => t.key === meta.id)) {
      setStore((s) => focusTab(s, meta.id));
      return;
    }
    let seed;
    let failed = false;
    try {
      seed = await getTranscript(agentBase, meta.id);
    } catch {
      failed = true;
      seed = [{ kind: "result" as const, text: "History unavailable for this session" }];
    }
    setStore((s) => {
      let next = openTab(s, meta.id, meta.title, seed);
      if (failed) next = setHistoryNotice(next, meta.id);
      return next;
    });
    attachSessionStream(meta.id);
  }

  function newDraft() {
    const key = `draft:${crypto.randomUUID()}`;
    setStore((s) => openTab(s, key, "New session"));
  }

  function close(key: string) {
    sessionStops.current.get(key)?.();
    sessionStops.current.delete(key);
    const timer = retryTimers.current.get(key);
    if (timer) clearTimeout(timer);
    retryTimers.current.delete(key);
    for (const [turnId, k] of turnKey.current.entries()) {
      if (k === key) {
        turnStops.current.get(turnId)?.();
        turnStops.current.delete(turnId);
      }
    }
    setStore((s) => closeTab(s, key));
  }

  function focus(key: string) {
    setStore((s) => focusTab(s, key));
  }

  function setTabTitle(key: string, title: string) {
    setStore((s) => setTitle(s, key, title));
  }

  async function send(key: string, text: string, files: StagedFile[]): Promise<boolean> {
    let prompt = text;
    if (files.length > 0) {
      try {
        const paths: string[] = [];
        for (const f of files) paths.push(await uploadFile(agentBase, f.name, f.contentBase64));
        prompt = `${text}\n\n[Attached files: ${paths.join(", ")}]`;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setStore((s) => reduceEvent(s, key, { type: "error", message: `Upload failed: ${detail}` }));
        return false;
      }
    }
    setStore((s) => addUserMessage(s, key, text, files.map((f) => f.name)));

    const tab = storeRef.current.tabs.find((t) => t.key === key);
    const sessionId = tab?.agent.sessionId ?? undefined;
    const turnId = crypto.randomUUID();
    turnKey.current.set(turnId, key);
    setStore((s) => bumpTurns(s, key, 1));

    const stop = openAgentStream(agentBase, turnId, (event) => {
      const k = turnKey.current.get(turnId) ?? key;
      if (event.type === "session" && k.startsWith("draft:")) {
        turnKey.current.set(turnId, event.sessionId);
        setStore((s) => promoteDraft(s, k, event.sessionId));
        attachSessionStream(event.sessionId);
      }
      // Known double-delivery caveat (accepted per spec): once a tab has an
      // attached session stream, a locally sent turn's content events arrive on
      // BOTH the turn stream and the session stream. To avoid double-rendering,
      // only reduce content here when the tab has NO attached session stream
      // (i.e. draft tabs, before promotion). Turn accounting always runs below.
      const targetKey = turnKey.current.get(turnId) ?? k;
      const hasSessionStream = sessionStops.current.has(targetKey);
      if (!hasSessionStream) {
        setStore((s) => reduceEvent(s, targetKey, event));
      }
      if (event.type === "result" || event.type === "error") {
        if (turnStops.current.has(turnId)) {
          turnStops.current.get(turnId)?.();
          turnStops.current.delete(turnId);
          setStore((s) => bumpTurns(s, turnKey.current.get(turnId) ?? k, -1));
        }
      }
    });
    turnStops.current.set(turnId, stop);

    try {
      await sendMessage(agentBase, turnId, prompt, sessionId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const k = turnKey.current.get(turnId) ?? key;
      if (turnStops.current.has(turnId)) {
        turnStops.current.get(turnId)?.();
        turnStops.current.delete(turnId);
        setStore((s) => bumpTurns(s, k, -1));
      }
      setStore((s) => reduceEvent(s, k, { type: "error", message: `Send failed: ${detail}` }));
      return false;
    }
    return true;
  }

  return { store, openSession, newDraft, close, focus, send, setTabTitle };
}
