import { useEffect, useState } from "react";
import { ConnectionScreen } from "./components/ConnectionScreen";
import { Workspace } from "./components/Workspace";
import { ConfirmationDialog } from "./components/ConfirmationDialog";
import { agentBaseOf, dashboardBaseOf, getConfig, setConfig, type AppConfig } from "./lib/tauri";

export function App() {
  const [config, setConfigState] = useState<AppConfig | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getConfig()
      .then((c) => {
        if (c.baseUrl) setConfigState(c);
      })
      .catch(() => {
        // getConfig rejects when Tauri IPC is unavailable (plain-browser dev);
        // fall through to the connection screen instead of hanging on Loading.
      })
      .finally(() => setLoaded(true));
  }, []);

  async function disconnect() {
    setConfigState(null);
    try {
      await setConfig({ baseUrl: "", agentPath: "/agent", dashboardPath: "/" });
    } catch {
      // state is already reset; nothing actionable
    }
  }

  if (!loaded) return <div className="flex h-full items-center justify-center text-muted">Loading…</div>;
  if (!config) return <ConnectionScreen onConnected={setConfigState} />;
  const agentBase = agentBaseOf(config);
  const dashboardBase = dashboardBaseOf(config);
  return (
    <>
      <Workspace agentBase={agentBase} dashboardBase={dashboardBase} onDisconnect={disconnect} />
      <ConfirmationDialog agentBase={agentBase} dashboardBase={dashboardBase} />
    </>
  );
}
