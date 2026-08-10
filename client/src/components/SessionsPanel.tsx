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

const DAY_MS = 86400000;

// Three fixed buckets, matching the design. "Previous 30 days" is the tail
// bucket and takes everything older too — the host already excludes archived
// sessions, so an unbounded tail is the honest place for them.
export function groupSessions(
  list: SessionMeta[],
  now: number,
): { label: string; items: SessionMeta[] }[] {
  const buckets: { label: string; items: SessionMeta[] }[] = [
    { label: "Today", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Previous 30 days", items: [] },
  ];
  for (const s of list) {
    const age = now - Date.parse(s.lastActiveAt);
    const i = age < DAY_MS ? 0 : age < 7 * DAY_MS ? 1 : 2;
    buckets[i].items.push(s);
  }
  return buckets.filter((b) => b.items.length > 0);
}

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
  const [query, setQuery] = useState("");

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

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) => s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q))
    : sessions;
  const groups = groupSessions(filtered, Date.now());

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-col gap-2 px-4 pb-3">
        <div className="flex items-center gap-2 border border-line-strong bg-bg px-2.5 py-2">
          <span className="mn text-faint" aria-hidden>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions"
            placeholder="Search sessions…"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
          />
        </div>
        <div className="flex items-center gap-2.5">
          <span className="mn text-faint">
            {q ? `${filtered.length} of ${sessions.length} match` : `${sessions.length} sessions`}
          </span>
          <span className="flex-1" />
          <button onClick={onNew} className="mn text-accent">+ NEW</button>
        </div>
      </div>
      {error && <p className="px-4 pb-2 text-xs text-danger">Couldn't load sessions — retrying…</p>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-4 pb-1.5 pt-2.5"><span className="ey">{g.label}</span></div>
            <ul>
              {g.items.map((s) => {
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
                        className="w-full border border-accent bg-raised px-4 py-2 text-[13px] outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => onOpen(s)}
                        className="flex w-full items-center gap-2.5 border-l-2 border-transparent px-4 py-2.5 text-left hover:bg-raised"
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-[13px] text-muted">{s.title}</span>
                          <span className="truncate text-[11.5px] text-faint">{s.preview}</span>
                        </span>
                        {tab && tab.openTurns > 0 && (
                          <span aria-label={`${s.id} running`} className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
                        )}
                        {tab?.unread && (
                          <span aria-label={`${s.id} unread`} className="h-2 w-2 shrink-0 rounded-full border border-accent" />
                        )}
                        <span className="mn shrink-0 text-faint">{relTime(s.lastActiveAt)}</span>
                      </button>
                    )}
                    {renaming !== s.id && (
                      <span className="absolute right-2 top-2 hidden gap-1 group-hover:flex">
                        <button
                          aria-label={`Rename ${s.title}`}
                          onClick={() => { setRenaming(s.id); setDraftTitle(s.title); }}
                          className="bg-raised px-1 text-xs text-muted hover:text-ink"
                        >
                          ✎
                        </button>
                        <button
                          aria-label={`Archive ${s.title}`}
                          onClick={() => void archive(s.id)}
                          className="bg-raised px-1 text-xs text-muted hover:text-danger"
                        >
                          🗄
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="px-4 py-5 text-xs text-faint">No sessions yet.</p>
        )}
        {sessions.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-5 text-[12.5px] text-faint">No session matches that.</p>
        )}
      </div>
    </div>
  );
}
