export function GearPanel({
  agentBase,
  dashboardBase,
  onDisconnect,
}: {
  agentBase: string;
  dashboardBase: string;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Connection</h2>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">Agent host</span>
        <span className="truncate font-mono text-sm">{agentBase}</span>
        <span className="mt-1 text-xs text-muted">Dashboard host</span>
        <span className="truncate font-mono text-sm">{dashboardBase}</span>
      </div>
      <button
        onClick={onDisconnect}
        className="self-start rounded border border-line px-2 py-1 text-sm text-muted hover:border-danger hover:text-danger"
      >
        Disconnect
      </button>
    </div>
  );
}
