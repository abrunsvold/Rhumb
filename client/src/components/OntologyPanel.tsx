import { useState } from "react";
import { flattenNodes, filterNodes, registryIdFor } from "../lib/ontologyStore";
import type { OntologySnapshot } from "../lib/types";
import type { Tab } from "../lib/registryStore";

export function OntologyPanel({
  snapshot,
  error,
  onRefresh,
  surfaceTabs,
  activeSurfaceId,
  selectedNodeId,
  onSelectSurface,
  onSelectNode,
}: {
  snapshot: OntologySnapshot | null;
  error: string | null;
  onRefresh: () => void;
  surfaceTabs: Tab[];
  activeSurfaceId: string | null;
  selectedNodeId: string | null;
  onSelectSurface: (id: string) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const [query, setQuery] = useState("");

  // A fetch failure and a host-reported sync failure are different problems but
  // read the same to the operator; the fetch error wins because a stale
  // snapshot's syncError describes a run that is no longer the latest attempt.
  const shownError = error ?? snapshot?.syncError ?? null;
  const rows = snapshot ? flattenNodes(filterNodes(snapshot.nodes, query)) : [];

  // This tree is the ONLY surface-selection path, but its rows come from the
  // ontology projection — which lags a just-published surface and is absent
  // entirely when agent-host is unreachable while dashboard-host still streams
  // the registry. A surface the registry knows must stay selectable anyway, so
  // registry entries with no matching dashboard node get a minimal fallback
  // row (title only, no lineage — the ontology knows nothing else about them).
  // Membership is judged against the UNFILTERED snapshot: a node the query
  // hides is still known, so its surface must not reappear as a fallback.
  const q = query.trim().toLowerCase();
  const knownSurfaceIds = new Set(
    (snapshot?.nodes ?? [])
      .map((n) => registryIdFor(n))
      .filter((id): id is string => id !== null),
  );
  const fallbackSurfaces = surfaceTabs.filter(
    (t) =>
      !knownSurfaceIds.has(t.id) &&
      (q === "" || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-4 pb-3">
        <div className="flex items-center gap-2 border border-line-strong bg-bg px-2.5 py-2">
          <span className="mn text-faint" aria-hidden>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter nodes"
            placeholder={snapshot ? `Filter ${snapshot.nodes.length} nodes…` : "Filter…"}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
          />
          {/* The only way to re-sync the map without restarting the app. The
              panel no longer owns the fetch, so this has to reach the owner. */}
          <button
            type="button"
            aria-label="Refresh map"
            title={
              snapshot?.syncedAt
                ? `synced ${new Date(snapshot.syncedAt).toLocaleTimeString()}`
                : "Refresh"
            }
            onClick={onRefresh}
            className="mn shrink-0 text-faint hover:text-ink"
          >
            ↻
          </button>
        </div>
      </div>
      {shownError && (
        <p className="mx-4 mb-2 border border-line bg-raised px-2 py-1 text-xs text-muted">sync problem: {shownError}</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {rows.map(({ node, depth }) => {
          const rid = registryIdFor(node);
          const live = rid !== null && surfaceTabs.some((t) => t.id === rid);
          const selected = rid !== null ? rid === activeSurfaceId : node.id === selectedNodeId;
          // The active surface stays highlighted while a node is selected —
          // it is still what the operator returns to — but only ONE row may
          // report itself current, and a node selection is what the right-hand
          // column is actually showing. Workspace clears `selectedNode` when a
          // surface is picked; it does not clear `activeSurf` the other way.
          const current = selected && (rid === null || selectedNodeId === null);
          return (
            <button
              key={node.id}
              onClick={() => (rid !== null && live ? onSelectSurface(rid) : onSelectNode(node.id))}
              aria-current={current ? "true" : undefined}
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
        {fallbackSurfaces.map((t) => {
          const selected = t.id === activeSurfaceId;
          const current = selected && selectedNodeId === null;
          return (
            <button
              key={`registry:${t.id}`}
              onClick={() => onSelectSurface(t.id)}
              aria-current={current ? "true" : undefined}
              style={{ paddingLeft: "16px" }}
              className={
                selected
                  ? "flex w-full items-center gap-2.5 border-l-2 border-accent bg-raised py-1.5 pr-4 text-left"
                  : "flex w-full items-center gap-2.5 border-l-2 border-transparent py-1.5 pr-4 text-left hover:bg-raised"
              }
            >
              <span
                className={
                  selected
                    ? "min-w-0 flex-1 truncate text-[12.5px] text-ink"
                    : "min-w-0 flex-1 truncate text-[12.5px] text-muted"
                }
              >
                {t.title}
              </span>
              {/* Honest about what this row is: the registry knows the surface,
                  the map does not — "dashboard" here would claim a projection
                  that never happened. */}
              <span className="mn shrink-0 text-faint">unmapped</span>
            </button>
          );
        })}
        {snapshot && rows.length === 0 && fallbackSurfaces.length === 0 && (
          <p className="px-4 py-5 text-xs text-faint">Nothing on the map yet.</p>
        )}
      </div>
    </div>
  );
}
