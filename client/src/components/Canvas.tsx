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
    new WebviewWindow(`surface:${active.id}`, { url: activeUrl, title: active.title });
  }

  return (
    <div>
      <div role="tablist">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setActiveId(t.id)}>{t.title}</button>
        ))}
        {active && <button onClick={detach}>Detach</button>}
      </div>
      {activeUrl && (
        <iframe title={active!.title} src={activeUrl} sandbox="allow-scripts allow-same-origin" />
      )}
    </div>
  );
}
