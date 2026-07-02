import { useEffect, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { reduceRegistry, type Tab } from "../lib/registryStore";
import { openRegistryStream } from "../lib/tauri";

export function Canvas({ dashboardBase }: { dashboardBase: string }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const stop = openRegistryStream(dashboardBase, (snap) => {
      const next = reduceRegistry(snap);
      setTabs(next);
      setActiveId((cur) => cur ?? next[0]?.id ?? null);
    });
    return stop;
  }, [dashboardBase]);

  const active = tabs.find((t) => t.id === activeId) ?? null;
  const activeUrl = active ? `${dashboardBase}${active.url}` : null;

  function detach() {
    if (!active || !activeUrl) return;
    // The detached surface loads untrusted agent-built content. It is labeled
    // `surface:<id>`, which intentionally matches NO capability in
    // src-tauri/capabilities/default.json (that capability is scoped to
    // `"windows": ["main"]`), so this window inherits no Tauri IPC/command
    // access. Do not add a capability whose `windows` matches `surface:*`.
    new WebviewWindow(`surface:${active.id}`, { url: activeUrl, title: active.title });
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div role="tablist" className="flex items-center gap-1 overflow-x-auto border-b border-line bg-panel px-2 py-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            onClick={() => setActiveId(t.id)}
            className={
              t.id === activeId
                ? "shrink-0 rounded px-3 py-1 text-sm bg-raised text-ink border border-line"
                : "shrink-0 rounded px-3 py-1 text-sm text-muted hover:text-ink"
            }
          >
            {t.title}
          </button>
        ))}
        {active && (
          <button
            onClick={detach}
            className="ml-auto shrink-0 rounded px-2 py-1 text-xs text-muted border border-line hover:text-ink"
          >
            Detach ↗
          </button>
        )}
      </div>
      {activeUrl ? (
        <iframe
          title={active!.title}
          src={activeUrl}
          sandbox="allow-scripts allow-same-origin"
          className="h-full w-full flex-1 border-0 bg-white"
        />
      ) : (
        <p className="m-auto max-w-xs text-center text-muted">
          No surfaces yet — the agent will publish dashboards here.
        </p>
      )}
    </div>
  );
}
