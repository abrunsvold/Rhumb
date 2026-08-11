import type { OntologyNode } from "../lib/types";

export function TelemetryBar({
  surfaces,
  nodes,
  queued,
  syncedAt,
}: {
  surfaces: number;
  // `null` means NO snapshot has ever arrived (mount fetch pending or failed),
  // which is different from a synced-but-empty map: with nothing to count,
  // "NODES 0" would be an affirmative claim of an empty map the client cannot
  // support. Same principle as the refresh-failure path, which keeps the last
  // good snapshot instead of blanking it.
  nodes: OntologyNode[] | null;
  queued: number;
  syncedAt: string | null;
}) {
  const edges = nodes === null ? null : nodes.reduce((sum, n) => sum + n.relationships.length, 0);
  return (
    <div className="flex h-[30px] flex-none items-center gap-6 border-t border-line px-5">
      <span className="mn text-faint">SURFACES <span className="text-muted">{surfaces}</span></span>
      <span className="mn text-faint">NODES <span className="text-muted">{nodes === null ? "—" : nodes.length}</span></span>
      <span className="mn text-faint">EDGES <span className="text-muted">{edges === null ? "—" : edges}</span></span>
      <span className="flex-1" />
      <span className={queued > 0 ? "mn text-warn" : "mn text-faint"}>
        {queued > 0 ? `QUEUE ${queued} held` : "QUEUE clear"}
      </span>
      {syncedAt && (
        <span className="mn text-faint">synced {new Date(syncedAt).toLocaleTimeString()}</span>
      )}
    </div>
  );
}
