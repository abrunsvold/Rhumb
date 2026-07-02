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
    <div className="flex h-full items-center justify-center">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
        className="w-96 rounded-lg border border-line bg-panel p-6 flex flex-col gap-3"
      >
        <h1 className="text-lg font-semibold">Connect Rhumb</h1>
        <p className="text-xs text-muted -mt-2">Point the client at your agent and dashboard hosts.</p>
        <label htmlFor="agent" className="text-xs text-muted">Agent host</label>
        <input
          id="agent"
          placeholder="http://localhost:8787"
          value={agentBase}
          onChange={(e) => setAgentBase(e.target.value)}
          className="rounded border border-line bg-raised px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
        />
        <label htmlFor="dash" className="text-xs text-muted">Dashboard host</label>
        <input
          id="dash"
          placeholder="http://localhost:8788"
          value={dashboardBase}
          onChange={(e) => setDashboardBase(e.target.value)}
          className="rounded border border-line bg-raised px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
        />
        <label htmlFor="token" className="text-xs text-muted">Control token (optional)</label>
        <input
          id="token"
          type="password"
          value={controlToken}
          onChange={(e) => setControlToken(e.target.value)}
          className="rounded border border-line bg-raised px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy}
          className="mt-1 rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
        {error && (
          <p role="alert" className="rounded border border-danger/50 bg-danger/10 px-2 py-1.5 text-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
