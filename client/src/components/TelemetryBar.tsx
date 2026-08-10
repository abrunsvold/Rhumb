import type { OntologyNode } from "../lib/types";

export function TelemetryBar({
  surfaces,
  nodes,
  queued,
  syncedAt,
}: {
  surfaces: number;
  nodes: OntologyNode[];
  queued: number;
  syncedAt: string | null;
}) {
  const edges = nodes.reduce((sum, n) => sum + n.relationships.length, 0);
  return (
    <div className="flex h-[30px] flex-none items-center gap-6 border-t border-line px-5">
      <span className="mn text-faint">SURFACES <span className="text-muted">{surfaces}</span></span>
      <span className="mn text-faint">NODES <span className="text-muted">{nodes.length}</span></span>
      <span className="mn text-faint">EDGES <span className="text-muted">{edges}</span></span>
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
