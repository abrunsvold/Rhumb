import { useEffect, useState } from "react";
import {
  agentBaseOf,
  checkHealth,
  checkIdentity,
  dashboardBaseOf,
  discoverHosts,
  fetchManifest,
  setConfig,
  type AppConfig,
  type DiscoveryReport,
} from "../lib/tauri";

export function ConnectionScreen({ onConnected }: { onConnected: (c: AppConfig) => void }) {
  const [report, setReport] = useState<DiscoveryReport | null>(null);
  const found = report?.hosts ?? [];
  const [scanning, setScanning] = useState(true);
  const [manualUrl, setManualUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function scan() {
    setScanning(true);
    try {
      setReport(await discoverHosts());
    } catch {
      setReport({ hosts: [], scanned: 0, attempts: [] });
    }
    setScanning(false);
  }

  useEffect(() => {
    void scan();
  }, []);

  async function connect(rawUrl: string) {
    setBusy(true);
    setError(null);
    const baseUrl = rawUrl.trim().replace(/\/+$/, "");
    try {
      const manifest = await fetchManifest(baseUrl);
      const cfg: AppConfig = {
        baseUrl,
        agentPath: manifest.paths.agent,
        dashboardPath: manifest.paths.dashboard,
      };
      const [agentOk, dashOk] = await Promise.all([
        checkHealth(agentBaseOf(cfg)),
        checkHealth(dashboardBaseOf(cfg)),
      ]);
      if (!agentOk || !dashOk) {
        setError(`Could not reach ${!agentOk ? "the agent host" : "the dashboard host"}.`);
        return;
      }
      // /healthz is open on purpose, so a non-allowlisted device would pass the
      // health checks and then 403 on everything inside. Probe an identity-gated
      // route before persisting the config.
      const identityStatus = await checkIdentity(dashboardBaseOf(cfg));
      if (identityStatus === 403) {
        setError("The server is up, but this device's tailnet login is not in RHUMB_ALLOWED_USERS on the box.");
        return;
      }
      if (identityStatus !== 200) {
        setError(`The dashboard host answered ${identityStatus} on an authenticated route.`);
        return;
      }
      await setConfig(cfg);
      onConnected(cfg);
    } catch {
      setError(`No Rhumb server answered at ${baseUrl}. Is \`rhumb setup\` done on the box?`);
    } finally {
      setBusy(false);
    }
  }

  const hostname = (url: string) => url.replace(/^https?:\/\//, "");

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-[26rem] rounded-lg border border-line bg-panel p-6 flex flex-col gap-3">
        <h1 className="text-lg font-semibold">Connect Rhumb</h1>
        <p className="text-xs text-muted -mt-2">
          {scanning ? "Scanning your tailnet for Rhumb servers…" : found.length > 0 ? "Found on your tailnet:" : "No Rhumb servers found on your tailnet."}
        </p>
        {found.map((h) => (
          <button
            key={h.baseUrl}
            type="button"
            disabled={busy}
            onClick={() => void connect(h.baseUrl)}
            aria-label={`Connect to ${hostname(h.baseUrl)}`}
            className="flex items-center justify-between rounded border border-line bg-raised px-3 py-2 text-left hover:border-accent disabled:opacity-40"
          >
            <span className="font-mono text-sm">{hostname(h.baseUrl)}</span>
            <span className="text-xs text-muted">v{h.version}</span>
          </button>
        ))}
        {!scanning && found.length === 0 && report && (
          <div className="text-sm text-muted" data-testid="discovery-diagnostic">
            <p>
              Scanned {report.scanned} tailnet {report.scanned === 1 ? "peer" : "peers"} — none responded as Rhumb.
            </p>
            {report.attempts.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer">Details</summary>
                <ul className="mt-1 space-y-0.5">
                  {report.attempts.map((a, i) => (
                    <li key={i} className="font-mono text-xs">
                      {a.peer} ({a.target}) → {a.outcome}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="mt-1">Enter the server URL manually below.</p>
          </div>
        )}
        {!scanning && (
          <button type="button" onClick={() => void scan()} className="self-start text-xs text-muted underline">
            Rescan
          </button>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (manualUrl.trim()) void connect(manualUrl);
          }}
          className="flex flex-col gap-2 border-t border-line pt-3"
        >
          <label htmlFor="server" className="text-xs text-muted">
            Server URL
          </label>
          <input
            id="server"
            placeholder="https://box.your-tailnet.ts.net"
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            className="rounded border border-line bg-raised px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={busy || manualUrl.trim() === ""}
            className="rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
        {error && (
          <p role="alert" className="rounded border border-danger/50 bg-danger/10 px-2 py-1.5 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
