import { useEffect, useState } from "react";
import { ConnectionScreen } from "./components/ConnectionScreen";
import { Workspace } from "./components/Workspace";
import { getConfig, type AppConfig } from "./lib/tauri";

export function App() {
  const [config, setConfigState] = useState<AppConfig | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getConfig().then((c) => {
      if (c.agentBase && c.dashboardBase) setConfigState(c);
      setLoaded(true);
    });
  }, []);

  if (!loaded) return <div>Loading…</div>;
  if (!config) return <ConnectionScreen onConnected={setConfigState} />;
  return <Workspace agentBase={config.agentBase} dashboardBase={config.dashboardBase} />;
}
