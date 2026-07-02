import { AgentPanel } from "./AgentPanel";
import { Canvas } from "./Canvas";

export function Workspace({
  agentBase,
  dashboardBase,
  onDisconnect,
}: {
  agentBase: string;
  dashboardBase: string;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-3 py-1.5 text-xs">
        <span className="font-semibold tracking-wide">Rhumb</span>
        <span className="font-mono text-muted truncate">{agentBase}</span>
        <span className="font-mono text-muted truncate">{dashboardBase}</span>
        <button
          onClick={onDisconnect}
          className="ml-auto rounded border border-line px-2 py-0.5 text-muted hover:text-danger hover:border-danger"
        >
          Disconnect
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-64 w-2/5 max-w-[70%] resize-x overflow-hidden border-r border-line">
          <AgentPanel agentBase={agentBase} />
        </div>
        <div className="min-w-0 flex-1">
          <Canvas dashboardBase={dashboardBase} />
        </div>
      </div>
    </div>
  );
}
