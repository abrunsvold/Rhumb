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
    <div role="tablist" aria-label="Open sessions" className="flex flex-none items-center gap-2 overflow-x-auto border-b border-line px-4 py-2">
      {tabs.map((t) => (
        <span
          key={t.key}
          className={
            t.key === activeKey
              ? "mn flex shrink-0 items-center gap-1.5 border-b border-accent pb-1 text-ink"
              : "mn flex shrink-0 items-center gap-1.5 border-b border-transparent pb-1 text-faint hover:text-muted"
          }
        >
          <button role="tab" aria-selected={t.key === activeKey} onClick={() => onFocus(t.key)} className="flex items-center gap-1.5">
            <span className="max-w-40 truncate">{t.title}</span>
            {t.openTurns > 0 && (
              <span aria-label={`${t.title} running`} className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            )}
            {t.unread && (
              <span aria-label={`${t.title} unread`} className="h-1.5 w-1.5 rounded-full border border-accent" />
            )}
          </button>
          <button aria-label={`Close ${t.title}`} onClick={() => onClose(t.key)} className="text-faint hover:text-danger">
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
