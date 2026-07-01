import { AgentPanel } from "./AgentPanel";
import { Canvas } from "./Canvas";

export function Workspace({ agentBase, dashboardBase }: { agentBase: string; dashboardBase: string }) {
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div style={{ flex: "0 0 40%", overflow: "auto", resize: "horizontal" }}>
        <AgentPanel agentBase={agentBase} />
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <Canvas dashboardBase={dashboardBase} />
      </div>
    </div>
  );
}
