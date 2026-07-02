import type { Tab } from "../lib/registryStore";

export function SurfacesPanel({
  tabs,
  activeId,
  onSelect,
}: {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 p-2">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Surfaces</h2>
      <ul className="flex flex-col gap-0.5">
        {tabs.map((t) => (
          <li key={t.id}>
            <button
              onClick={() => onSelect(t.id)}
              className={
                t.id === activeId
                  ? "w-full rounded bg-raised px-2 py-1.5 text-left text-sm text-ink border border-line"
                  : "w-full rounded px-2 py-1.5 text-left text-sm text-muted hover:text-ink hover:bg-raised"
              }
            >
              <span className="block truncate">{t.title}</span>
            </button>
          </li>
        ))}
        {tabs.length === 0 && (
          <li className="px-2 py-4 text-center text-xs text-muted">No surfaces yet.</li>
        )}
      </ul>
    </div>
  );
}
