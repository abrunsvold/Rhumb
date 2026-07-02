import { useState } from "react";
import { AgentPanel } from "./AgentPanel";
import { Canvas } from "./Canvas";
import { Rail, type RailSection } from "./Rail";
import { GearPanel } from "./GearPanel";

export function Workspace({
  agentBase,
  dashboardBase,
  onDisconnect,
}: {
  agentBase: string;
  dashboardBase: string;
  onDisconnect: () => void;
}) {
  const [section, setSection] = useState<RailSection | null>(null);

  function toggle(s: RailSection) {
    setSection((cur) => (cur === s ? null : s));
  }

  return (
    <div className="flex h-screen">
      <Rail active={section} onSelect={toggle} />
      {section !== null && (
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-line bg-panel">
          {section === "gear" && (
            <GearPanel agentBase={agentBase} dashboardBase={dashboardBase} onDisconnect={onDisconnect} />
          )}
          {section === "sessions" && <div data-testid="sessions-panel-slot" />}
          {section === "surfaces" && <div data-testid="surfaces-panel-slot" />}
        </aside>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
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
