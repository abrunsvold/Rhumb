import { useCallback, useEffect, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Canvas } from "./Canvas";
import { TopBar } from "./TopBar";
import { TelemetryBar } from "./TelemetryBar";
import { NodeDetail } from "./NodeDetail";
import { SurfaceFrame } from "./SurfaceFrame";
import { Sidebar, type SidebarTab } from "./Sidebar";
import { HostPanel } from "./HostPanel";
import { SessionsPanel } from "./SessionsPanel";
import { OntologyPanel } from "./OntologyPanel";
import { ChatTabs } from "./ChatTabs";
import { AgentPanel } from "./AgentPanel";
import { ApprovalQueue } from "./ApprovalCard";
import { useChatSessions } from "../hooks/useChatSessions";
import { reduceRegistry, type Tab } from "../lib/registryStore";
import { reducePending, type PendingItem, type ResolvedItem } from "../lib/pendingStore";
import { summarizeOp } from "../lib/opSummary";
import {
  openRegistryStream,
  getOntology,
  openPendingStream,
  openInfraPendingStream,
  resolvePending,
  resolveInfraPending,
} from "../lib/tauri";
import { buildLineage } from "../lib/lineage";
import type { OntologySnapshot } from "../lib/types";

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
  // The ontology snapshot is owned here, not in OntologyPanel: the MAP tree,
  // the SurfaceFrame breadcrumb and the telemetry counts all read it, and a
  // per-panel fetch made the MAP tab's unmount silently drop the other two.
  const [ontology, setOntology] = useState<OntologySnapshot | null>(null);
  const [ontologyError, setOntologyError] = useState<string | null>(null);
  const [detachError, setDetachError] = useState(false);
  // Pendings carry no session id, so they cannot be attributed to a
  // conversation: they render in whichever transcript is active, and their
  // outcomes live here for the app's lifetime rather than per session.
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [resolved, setResolved] = useState<ResolvedItem[]>([]);

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
    const stopData = openPendingStream(dashboardBase, (e) => setPending((p) => reducePending(p, e, "data")));
    const stopInfra = openInfraPendingStream(agentBase, (e) => setPending((p) => reducePending(p, e, "infra")));
    return () => { stopData(); stopInfra(); };
  }, [agentBase, dashboardBase]);

  async function resolve(item: PendingItem, decision: "approve" | "deny", trust: boolean) {
    const summary = summarizeOp(item);
    try {
      if (item.origin === "data") {
        // Trust is an approval qualifier only — a denial never grants it.
        await resolvePending(dashboardBase, item.pendingId, decision, decision === "approve" && trust);
      } else {
        // Infra actions have no trust concept: there is no fourth argument.
        await resolveInfraPending(agentBase, item.pendingId, decision);
      }
    } catch (err) {
      // The host never confirmed the decision, so the item stays in `pending`
      // and can be retried. Dropping it here would let an unresolved write
      // vanish from the operator's view while still queued server-side.
      const detail = err instanceof Error ? err.message : String(err);
      setResolved((r) => [...r, { pendingId: item.pendingId, summary, outcome: `Could not resolve — ${detail}` }]);
      return;
    }
    const outcome =
      decision === "approve"
        ? // Mirrors what the host actually requires to write a trust pair
          // (dashboard-host/src/data/router.ts gates on `pending?.surfaceId`):
          // without a surface there is nothing to trust, the grant is silently
          // dropped, and claiming one here would report a grant the server
          // never made.
          trust && item.origin === "data" && !!item.surfaceId
          ? "Approved, and this surface is now trusted for adds and edits."
          // A resolved call means the host accepted the DECISION, not that the
          // write ran — it can still fail server-side afterwards (the audit
          // schema has a `decision: "error"` case for exactly that). Do not
          // restore any wording that claims execution.
          : "Approved — sent to the host to run."
        : "Denied — nothing was written.";
    setResolved((r) => [...r, { pendingId: item.pendingId, summary, outcome }]);
    setPending((p) => p.filter((x) => x.pendingId !== item.pendingId));
  }

  const loadOntology = useCallback(async () => {
    try {
      setOntology(await getOntology(agentBase));
      setOntologyError(null);
    } catch (e) {
      // Keep the last good snapshot: the breadcrumb and telemetry counts stay
      // truthful about what was last seen while the map panel names the error.
      setOntologyError(e instanceof Error ? e.message : String(e));
    }
  }, [agentBase]);

  useEffect(() => {
    void loadOntology();
  }, [loadOntology]);

  const ontologyNodes = ontology?.nodes ?? [];

  const selected = selectedNode ? ontologyNodes.find((n) => n.id === selectedNode) ?? null : null;
  const activeSurface = surfTabs.find((t) => t.id === activeSurf) ?? null;
  const lineageId = selected ? selected.id : activeSurf ? `dashboard-${activeSurf}` : null;
  const userTurns = active ? active.agent.messages.filter((m) => m.kind === "user").length : 0;

  return (
    <div className="flex h-screen flex-col bg-bg">
      <TopBar title={active?.title ?? "Rhumb"} turns={userTurns} baseUrl={agentBase} />
      {/* The gap-px over a bg-line grid draws the 1px column rules. The fixed
          track widths replace the old resize-x chat column: below ~1152px the
          grid scrolls horizontally rather than crushing a column. */}
      <div className="grid min-h-0 flex-1 gap-px overflow-x-auto bg-line [grid-template-columns:272px_minmax(320px,0.9fr)_minmax(560px,1.3fr)]">
        <Sidebar active={tab} onSelect={setTab}>
          {tab === "sessions" && (
            <SessionsPanel
              agentBase={agentBase}
              tabs={chat.store.tabs}
              activeKey={chat.store.activeKey}
              onOpen={(m) => void chat.openSession({ id: m.id, title: m.title })}
              onNew={() => chat.newDraft()}
            />
          )}
          {tab === "map" && (
            <OntologyPanel
              snapshot={ontology}
              error={ontologyError}
              onRefresh={() => void loadOntology()}
              surfaceTabs={surfTabs}
              activeSurfaceId={activeSurf}
              selectedNodeId={selectedNode}
              // Picking a surface must drop any node selection, or the detail
              // pane stays pinned on the node and the surface never shows.
              onSelectSurface={(id) => { setActiveSurf(id); setSelectedNode(null); }}
              onSelectNode={setSelectedNode}
            />
          )}
          {tab === "host" && (
            <HostPanel agentBase={agentBase} dashboardBase={dashboardBase} onDisconnect={onDisconnect} />
          )}
        </Sidebar>

        <div className="flex min-h-0 min-w-0 flex-col bg-bg">
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
              pending={pending}
              resolved={resolved}
              onResolve={resolve}
            />
          ) : (
            // Closing the last tab must not strand the approval queue: the
            // pendings are held server-side either way, so with no transcript
            // to host them the cards render here instead. The dialog this
            // replaced was a sibling of Workspace and drew regardless of tab
            // state; dropping them here would leave a write queued with no way
            // to approve or deny it.
            <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-7">
              <p className="text-[13px] text-faint">Open a session or start a new one.</p>
              <ApprovalQueue pending={pending} resolved={resolved} onResolve={resolve} />
            </div>
          )}
        </div>

        <div className="flex min-h-0 min-w-0 flex-col bg-bg">
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
      {/* `queued` is the only remaining indicator of how many writes and infra
          actions are held for approval — the modal that used to carry that
          count is gone, so it must track the real pending array. */}
      <TelemetryBar
        surfaces={surfTabs.length}
        nodes={ontologyNodes}
        queued={pending.length}
        syncedAt={ontology?.syncedAt ?? null}
      />
    </div>
  );
}
