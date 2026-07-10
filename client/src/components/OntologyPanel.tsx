import { useCallback, useEffect, useState } from "react";
import { getOntology } from "../lib/tauri";
import { groupNodes, filterNodes, registryIdFor } from "../lib/ontologyStore";
import type { OntologyNode, OntologySnapshot } from "../lib/types";
import type { Tab } from "../lib/registryStore";

export function OntologyPanel({
  agentBase,
  surfaceTabs,
  activeSurfaceId,
  onSelectSurface,
}: {
  agentBase: string;
  surfaceTabs: Tab[];
  activeSurfaceId: string | null;
  onSelectSurface: (id: string) => void;
}) {
  const [snap, setSnap] = useState<OntologySnapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnap(await getOntology(agentBase));
      setFetchError(null);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    }
  }, [agentBase]);

  useEffect(() => {
    void load();
  }, [load]);

  const error = fetchError ?? snap?.syncError ?? null;
  const groups = snap ? groupNodes(filterNodes(snap.nodes, query)) : [];

  const row = (n: OntologyNode) => {
    const rid = registryIdFor(n);
    if (rid !== null) {
      const live = surfaceTabs.some((t) => t.id === rid);
      return (
        <button
          onClick={() => onSelectSurface(rid)}
          disabled={!live}
          aria-current={rid === activeSurfaceId ? "true" : undefined}
          className={
            rid === activeSurfaceId
              ? "w-full rounded bg-raised px-2 py-1.5 text-left text-sm text-ink border border-line"
              : "w-full rounded px-2 py-1.5 text-left text-sm text-muted hover:text-ink hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          }
        >
          <span className="block truncate">{n.title}</span>
        </button>
      );
    }
    const open = expanded === n.id;
    return (
      <>
        <button
          onClick={() => setExpanded(open ? null : n.id)}
          aria-expanded={open}
          className="w-full rounded px-2 py-1.5 text-left text-sm text-muted hover:text-ink hover:bg-raised"
        >
          <span className="block truncate">{n.title}</span>
        </button>
        {open && (
          <div className="mx-2 mb-1 rounded border border-line bg-raised px-2 py-1.5 text-xs text-muted">
            <div className="mb-1 text-[10px] uppercase tracking-wide">{n.managed}</div>
            {Object.entries(n.props).map(([k, v]) => (
              <div key={k} className="truncate">
                {k}: {v}
              </div>
            ))}
            {n.relationships.map((r) => (
              <div key={`${r.edge}:${r.target}`} className="truncate">
                {r.edge} → {r.target}
              </div>
            ))}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">System map</h2>
        <button
          aria-label="Refresh"
          title={snap?.syncedAt ? `synced ${new Date(snap.syncedAt).toLocaleTimeString()}` : "Refresh"}
          onClick={() => void load()}
          className="rounded px-1 text-muted hover:text-ink"
        >
          ↻
        </button>
      </div>
      {error && (
        <p className="rounded border border-line bg-raised px-2 py-1 text-xs text-muted">sync problem: {error}</p>
      )}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter…"
        className="rounded border border-line bg-raised px-2 py-1 text-sm text-ink placeholder:text-muted"
      />
      {groups.map((g) => (
        <section key={g.type}>
          <h3 className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{g.label}</h3>
          <ul className="flex flex-col gap-0.5">
            {g.nodes.map((n) => (
              <li key={n.id}>{row(n)}</li>
            ))}
          </ul>
        </section>
      ))}
      {snap && groups.length === 0 && (
        <p className="px-2 py-4 text-center text-xs text-muted">Nothing on the map yet.</p>
      )}
    </div>
  );
}
