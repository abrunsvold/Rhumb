import { useState } from "react";
import { checkHealth, setConfig, type AppConfig } from "../lib/tauri";

export function ConnectionScreen({ onConnected }: { onConnected: (c: AppConfig) => void }) {
  const [agentBase, setAgentBase] = useState("");
  const [dashboardBase, setDashboardBase] = useState("");
  const [controlToken, setControlToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    setError(null);
    const [agentOk, dashOk] = await Promise.all([checkHealth(agentBase), checkHealth(dashboardBase)]);
    if (!agentOk || !dashOk) {
      setError(`Could not reach ${!agentOk ? "the agent host" : "the dashboard host"}.`);
      setBusy(false);
      return;
    }
    const cfg: AppConfig = { agentBase, dashboardBase, controlToken: controlToken.trim() || undefined };
    await setConfig(cfg);
    setBusy(false);
    onConnected(cfg);
  }

  return (
    <div>
      <h1>Connect Rhumb</h1>
      <label htmlFor="agent">Agent host</label>
      <input id="agent" value={agentBase} onChange={(e) => setAgentBase(e.target.value)} />
      <label htmlFor="dash">Dashboard host</label>
      <input id="dash" value={dashboardBase} onChange={(e) => setDashboardBase(e.target.value)} />
      <label htmlFor="token">Control token (optional)</label>
      <input id="token" type="password" value={controlToken} onChange={(e) => setControlToken(e.target.value)} />
      <button onClick={connect} disabled={busy}>Connect</button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
