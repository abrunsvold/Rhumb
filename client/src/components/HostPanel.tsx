export function HostPanel({
  agentBase,
  dashboardBase,
  onDisconnect,
}: {
  agentBase: string;
  dashboardBase: string;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex flex-col gap-3.5 px-4">
      <div className="flex flex-col gap-1.5">
        <span className="ey">Agent host</span>
        <span className="mn truncate text-ink">{agentBase}</span>
        <span className="ey mt-1.5">Dashboard host</span>
        <span className="mn truncate text-ink">{dashboardBase}</span>
      </div>
      <button
        onClick={onDisconnect}
        className="mn self-start whitespace-nowrap border border-line-strong px-2.5 py-1.5 text-muted hover:border-danger hover:text-danger"
      >
        DISCONNECT
      </button>
    </div>
  );
}
