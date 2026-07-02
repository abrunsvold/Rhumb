import type { TabState } from "../lib/chatStore";

export function ChatTabs({
  tabs,
  activeKey,
  onFocus,
  onClose,
}: {
  tabs: TabState[];
  activeKey: string | null;
  onFocus: (key: string) => void;
  onClose: (key: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div role="tablist" aria-label="Open sessions" className="flex items-center gap-1 overflow-x-auto border-b border-line bg-panel px-1 py-1">
      {tabs.map((t) => (
        <span
          key={t.key}
          className={
            t.key === activeKey
              ? "flex shrink-0 items-center gap-1.5 rounded border border-line bg-raised px-2 py-1 text-sm text-ink"
              : "flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-sm text-muted hover:text-ink"
          }
        >
          <button role="tab" aria-selected={t.key === activeKey} onClick={() => onFocus(t.key)} className="flex items-center gap-1.5">
            <span className="max-w-40 truncate">{t.title}</span>
            {t.openTurns > 0 && (
              <span aria-label={`${t.title} running`} className="h-2 w-2 animate-pulse rounded-full bg-accent" />
            )}
            {t.unread && (
              <span aria-label={`${t.title} unread`} className="h-2 w-2 rounded-full border border-accent bg-accent-soft" />
            )}
          </button>
          <button aria-label={`Close ${t.title}`} onClick={() => onClose(t.key)} className="text-muted hover:text-danger">
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
