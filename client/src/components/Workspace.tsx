import { useEffect, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Canvas } from "./Canvas";
import { NodeDetail } from "./NodeDetail";
import { SurfaceFrame } from "./SurfaceFrame";
import { Sidebar, type SidebarTab } from "./Sidebar";
import { HostPanel } from "./HostPanel";
import { SessionsPanel } from "./SessionsPanel";
import { OntologyPanel } from "./OntologyPanel";
import { ChatTabs } from "./ChatTabs";
import { AgentPanel } from "./AgentPanel";
import { useChatSessions } from "../hooks/useChatSessions";
import { reduceRegistry, type Tab } from "../lib/registryStore";
import { openRegistryStream, getOntology } from "../lib/tauri";
import { buildLineage } from "../lib/lineage";
import type { OntologyNode } from "../lib/types";

export function Workspace({
  agentBase,
  dashboardBase,
  onDisconnect,
}: {
  agentBase: string;
  dashboardBase: string;
  onDisconnect: () => void;
}) {
  const [tab, setTab] = useState<SidebarTab>("sessions");
  const chat = useChatSessions(agentBase);
  const active = chat.store.tabs.find((t) => t.key === chat.store.activeKey) ?? null;
  const [surfTabs, setSurfTabs] = useState<Tab[]>([]);
  const [activeSurf, setActiveSurf] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [ontologyNodes, setOntologyNodes] = useState<OntologyNode[]>([]);
  const [detachError, setDetachError] = useState(false);

  function detach() {
    const active = surfTabs.find((t) => t.id === activeSurf);
    if (!active) return;
    // The detached surface loads untrusted agent-built content. It is labeled
    // `surface:<id>`, which intentionally matches NO capability in
    // src-tauri/capabilities/default.json (that capability is scoped to
    // `"windows": ["main"]`), so this window inherits no Tauri IPC/command
    // access. Do not add a capability whose `windows` matches `surface:*`.
    const w = new WebviewWindow(`surface:${active.id}`, {
      url: `${dashboardBase}${active.url}`,
      title: active.title,
    });
    void w.once("tauri://created", () => setDetachError(false));
    void w.once("tauri://error", () => setDetachError(true));
  }

  const draftOpened = useRef(false);
  useEffect(() => {
    if (!draftOpened.current && chat.store.tabs.length === 0) {
      draftOpened.current = true;
      chat.newDraft();
    }
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

  useEffect(() => {
    getOntology(agentBase)
      .then((s) => setOntologyNodes(s.nodes))
      .catch(() => setOntologyNodes([])); // breadcrumb degrades to empty; the map panel reports the error
  }, [agentBase]);

  const selected = selectedNode ? ontologyNodes.find((n) => n.id === selectedNode) ?? null : null;
  const activeSurface = surfTabs.find((t) => t.id === activeSurf) ?? null;
  const lineageId = selected ? selected.id : activeSurf ? `dashboard-${activeSurf}` : null;

  return (
    <div className="flex h-screen">
      <div className="w-[272px] shrink-0 border-r border-line">
        <Sidebar active={tab} onSelect={setTab}>
          {tab === "sessions" && (
            <SessionsPanel
              agentBase={agentBase}
              tabs={chat.store.tabs}
              onOpen={(m) => void chat.openSession({ id: m.id, title: m.title })}
              onNew={() => chat.newDraft()}
            />
          )}
          {tab === "map" && (
            <OntologyPanel
              agentBase={agentBase}
              surfaceTabs={surfTabs}
              activeSurfaceId={activeSurf}
              selectedNodeId={selectedNode}
              onSelectSurface={(id) => { setActiveSurf(id); setSelectedNode(null); }}
              onSelectNode={setSelectedNode}
            />
          )}
          {tab === "host" && (
            <HostPanel agentBase={agentBase} dashboardBase={dashboardBase} onDisconnect={onDisconnect} />
          )}
        </Sidebar>
      </div>
      {/* chat + canvas columns unchanged for now — Task 13 replaces this wrapper */}
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
          <SurfaceFrame
            lineage={lineageId ? buildLineage(ontologyNodes, lineageId) : []}
            onDetach={selected ? undefined : detach}
            detachError={detachError}
          >
            {selected ? (
              <NodeDetail node={selected} />
            ) : (
              <Canvas dashboardBase={dashboardBase} active={activeSurface} />
            )}
          </SurfaceFrame>
        </div>
      </div>
    </div>
  );
}
