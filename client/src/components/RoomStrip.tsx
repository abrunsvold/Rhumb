import type { RosterEntry } from "../lib/tauri";

// Contextual by design: a solo operator with an idle queue gets no strip at
// all, so the single-user client looks exactly as it did before rooms existed.
export function RoomStrip({
  presence,
  queueDepth,
  roster,
}: {
  presence: string[];
  queueDepth: number;
  roster: RosterEntry[];
}) {
  if (presence.length <= 1 && queueDepth === 0) return null;

  // A departed teammate is no longer in the allowlist but still belongs in the
  // room's history, so an unknown login renders as itself.
  const label = (login: string) =>
    roster.find((r) => r.login === login)?.handle ?? login;

  return (
    <div
      data-testid="room-strip"
      className="flex items-center gap-2 border-b border-line bg-raised px-3 py-1 text-xs text-muted"
    >
      {presence.length > 1 && <span>{presence.map(label).join(", ")}</span>}
      {queueDepth > 0 && (
        <span className="ml-auto rounded-full border border-line px-2 py-0.5">
          {queueDepth} waiting
        </span>
      )}
    </div>
  );
}
