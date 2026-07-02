import { useEffect, useState } from "react";
import { Canvas } from "./Canvas";
import { Rail, type RailSection } from "./Rail";
import { GearPanel } from "./GearPanel";
import { SessionsPanel } from "./SessionsPanel";
import { SurfacesPanel } from "./SurfacesPanel";
import { ChatTabs } from "./ChatTabs";
import { AgentPanel } from "./AgentPanel";
import { useChatSessions } from "../hooks/useChatSessions";
import { reduceRegistry, type Tab } from "../lib/registryStore";
import { openRegistryStream } from "../lib/tauri";

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
  const chat = useChatSessions(agentBase);
  const active = chat.store.tabs.find((t) => t.key === chat.store.activeKey) ?? null;
  const [surfTabs, setSurfTabs] = useState<Tab[]>([]);
  const [activeSurf, setActiveSurf] = useState<string | null>(null);

  useEffect(() => {
    if (chat.store.tabs.length === 0) chat.newDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const stop = openRegistryStream(dashboardBase, (snap) => {
      const next = reduceRegistry(snap);
      setSurfTabs(next);
      setActiveSurf((cur) => cur ?? next[0]?.id ?? null);
    });
    return stop;
  }, [dashboardBase]);

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
          {section === "sessions" && (
            <SessionsPanel
              agentBase={agentBase}
              tabs={chat.store.tabs}
              onOpen={(m) => void chat.openSession({ id: m.id, title: m.title })}
              onNew={() => chat.newDraft()}
            />
          )}
          {section === "surfaces" && (
            <SurfacesPanel tabs={surfTabs} activeId={activeSurf} onSelect={setActiveSurf} />
          )}
        </aside>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-w-64 w-2/5 max-w-[70%] resize-x flex-col overflow-hidden border-r border-line">
          <ChatTabs
            tabs={chat.store.tabs}
            activeKey={chat.store.activeKey}
            onFocus={chat.focus}
            onClose={chat.close}
          />
          {active ? (
            <AgentPanel
              tab={active}
              slashCommands={active.agent.slashCommands}
              onSend={(text, files) => chat.send(active.key, text, files)}
            />
          ) : (
            <p className="m-auto text-sm text-muted">Open a session or start a new one.</p>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <Canvas dashboardBase={dashboardBase} tabs={surfTabs} activeId={activeSurf} onSelect={setActiveSurf} />
        </div>
      </div>
    </div>
  );
}
