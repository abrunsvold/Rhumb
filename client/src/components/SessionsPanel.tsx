import { useEffect, useRef, useState } from "react";
import { listSessions, renameSession, archiveSession } from "../lib/tauri";
import type { SessionMeta } from "../lib/types";

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

interface BadgeTab { key: string; openTurns: number; unread: boolean }

export function SessionsPanel({
  agentBase,
  tabs,
  onOpen,
  onNew,
}: {
  agentBase: string;
  tabs: BadgeTab[];
  onOpen: (meta: SessionMeta) => void;
  onNew: () => void;
}) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [error, setError] = useState(false);

  async function refresh() {
    try {
      setSessions(await listSessions(agentBase));
      setError(false);
    } catch {
      setError(true); // keep the last list; retry via interval
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentBase]);

  const runningCount = tabs.filter((t) => t.openTurns > 0).length;
  const prevRunning = useRef(runningCount);
  useEffect(() => {
    if (runningCount < prevRunning.current) void refresh();
    prevRunning.current = runningCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningCount]);

  async function submitRename(id: string) {
    const title = draftTitle.trim();
    setRenaming(null);
    if (!title) return;
    try {
      await renameSession(agentBase, id, title);
    } finally {
      void refresh();
    }
  }

  async function archive(id: string) {
    try {
      await archiveSession(agentBase, id);
    } finally {
      void refresh();
    }
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      <button
        onClick={onNew}
        className="rounded bg-accent px-2 py-1.5 text-sm font-medium text-white"
      >
        New session
      </button>
      {error && <p className="px-2 text-xs text-danger">Couldn't load sessions — retrying…</p>}
      <ul className="flex flex-col gap-0.5">
        {sessions.map((s) => {
          const tab = tabs.find((t) => t.key === s.id);
          return (
            <li key={s.id} className="group relative">
              {renaming === s.id ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitRename(s.id);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onBlur={() => setRenaming(null)}
                  className="w-full rounded border border-accent bg-raised px-2 py-1 text-sm outline-none"
                />
              ) : (
                <button
                  onClick={() => onOpen(s)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-raised"
                >
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  {tab && tab.openTurns > 0 && (
                    <span aria-label={`${s.id} running`} className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                  )}
                  {tab?.unread && (
                    <span aria-label={`${s.id} unread`} className="h-2 w-2 rounded-full bg-accent-soft border border-accent" />
                  )}
                  <span className="shrink-0 text-xs text-muted">{relTime(s.lastActiveAt)}</span>
                </button>
              )}
              {renaming !== s.id && (
                <span className="absolute right-1 top-1 hidden gap-1 group-hover:flex">
                  <button
                    aria-label={`Rename ${s.title}`}
                    onClick={() => {
                      setRenaming(s.id);
                      setDraftTitle(s.title);
                    }}
                    className="rounded bg-raised px-1 text-xs text-muted hover:text-ink"
                  >
                    ✎
                  </button>
                  <button
                    aria-label={`Archive ${s.title}`}
                    onClick={() => void archive(s.id)}
                    className="rounded bg-raised px-1 text-xs text-muted hover:text-danger"
                  >
                    🗄
                  </button>
                </span>
              )}
            </li>
          );
        })}
        {sessions.length === 0 && (
          <li className="px-2 py-4 text-center text-xs text-muted">No sessions yet.</li>
        )}
      </ul>
    </div>
  );
}
