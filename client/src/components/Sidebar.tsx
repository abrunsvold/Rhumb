export type SidebarTab = "sessions" | "map" | "host";

const TABS: { id: SidebarTab; label: string }[] = [
  { id: "sessions", label: "SESSIONS" },
  { id: "map", label: "MAP" },
  { id: "host", label: "HOST" },
];

export function Sidebar({
  active,
  onSelect,
  children,
}: {
  active: SidebarTab;
  onSelect: (t: SidebarTab) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden bg-panel">
      <div role="tablist" aria-label="Sidebar" className="flex flex-none gap-4 px-4 pb-3.5 pt-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            onClick={() => onSelect(t.id)}
            className={
              active === t.id
                ? "ey border-b border-accent pb-[5px] text-ink"
                : "ey border-b border-transparent pb-[5px] hover:text-muted"
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
