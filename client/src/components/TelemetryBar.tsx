import type { OntologyNode } from "../lib/types";
import type { RosterEntry } from "../lib/tauri";

export function TelemetryBar({
  surfaces,
  nodes,
  queued,
  syncedAt,
  presence,
  turnDepth,
  roster,
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
  // Room state for the active session. Contextual by design: a solo operator
  // with an idle turn queue sees neither segment, so the single-user bar looks
  // exactly as it did before rooms existed.
  presence: string[];
  turnDepth: number;
  roster: RosterEntry[];
}) {
  const edges = nodes === null ? null : nodes.reduce((sum, n) => sum + n.relationships.length, 0);
  // The wire depth counts the RUNNING turn as well as queued ones, so a lone
  // operator mid-turn reports 1. Only genuinely-waiting turns belong in a
  // segment whose whole point is to stay invisible when you are alone and idle.
  const waiting = Math.max(0, turnDepth - 1);
  // A departed teammate is no longer in the allowlist but still belongs in the
  // room, so an unknown login renders as itself.
  const label = (login: string) => roster.find((r) => r.login === login)?.handle ?? login;
  return (
    <div className="flex h-[30px] flex-none items-center gap-6 border-t border-line px-5">
      <span className="mn text-faint">SURFACES <span className="text-muted">{surfaces}</span></span>
      <span className="mn text-faint">NODES <span className="text-muted">{nodes === null ? "—" : nodes.length}</span></span>
      <span className="mn text-faint">EDGES <span className="text-muted">{edges === null ? "—" : edges}</span></span>
      {presence.length > 1 && (
        <span data-testid="room-presence" className="mn text-faint">
          ROOM <span className="text-muted">{presence.map(label).join(", ")}</span>
        </span>
      )}
      {waiting > 0 && (
        <span data-testid="room-waiting" className="mn text-warn">
          TURNS {waiting} waiting
        </span>
      )}
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
