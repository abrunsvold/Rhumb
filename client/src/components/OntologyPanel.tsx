import { useCallback, useEffect, useState } from "react";
import { getOntology } from "../lib/tauri";
import { flattenNodes, filterNodes, registryIdFor } from "../lib/ontologyStore";
import type { OntologySnapshot } from "../lib/types";
import type { Tab } from "../lib/registryStore";

export function OntologyPanel({
  agentBase,
  surfaceTabs,
  activeSurfaceId,
  selectedNodeId,
  onSelectSurface,
  onSelectNode,
}: {
  agentBase: string;
  surfaceTabs: Tab[];
  activeSurfaceId: string | null;
  selectedNodeId: string | null;
  onSelectSurface: (id: string) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const [snap, setSnap] = useState<OntologySnapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

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
  const rows = snap ? flattenNodes(filterNodes(snap.nodes, query)) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-4 pb-3">
        <div className="flex items-center gap-2 border border-line-strong bg-bg px-2.5 py-2">
          <span className="mn text-faint" aria-hidden>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter nodes"
            placeholder={snap ? `Filter ${snap.nodes.length} nodes…` : "Filter…"}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
          />
        </div>
      </div>
      {error && (
        <p className="mx-4 mb-2 border border-line bg-raised px-2 py-1 text-xs text-muted">sync problem: {error}</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {rows.map(({ node, depth }) => {
          const rid = registryIdFor(node);
          const live = rid !== null && surfaceTabs.some((t) => t.id === rid);
          const selected = rid !== null ? rid === activeSurfaceId : node.id === selectedNodeId;
          return (
            <button
              key={node.id}
              onClick={() => (rid !== null && live ? onSelectSurface(rid) : onSelectNode(node.id))}
              aria-current={selected ? "true" : undefined}
              style={{ paddingLeft: `${16 + depth * 16}px` }}
              className={
                selected
                  ? "flex w-full items-center gap-2.5 border-l-2 border-accent bg-raised py-1.5 pr-4 text-left"
                  : "flex w-full items-center gap-2.5 border-l-2 border-transparent py-1.5 pr-4 text-left hover:bg-raised"
              }
            >
              <span className="mn text-line-strong" aria-hidden>{depth === 0 ? "" : "└"}</span>
              <span
                className={
                  selected
                    ? "min-w-0 flex-1 truncate text-[12.5px] text-ink"
                    : "min-w-0 flex-1 truncate text-[12.5px] text-muted"
                }
              >
                {node.title}
              </span>
              <span className="mn shrink-0 text-faint">{rid !== null && !live ? "—" : node.type}</span>
            </button>
          );
        })}
        {snap && rows.length === 0 && (
          <p className="px-4 py-5 text-xs text-faint">Nothing on the map yet.</p>
        )}
      </div>
    </div>
  );
}
