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
    <div className="flex h-full items-center justify-center bg-bg">
      <div className="flex w-full max-w-[420px] flex-col gap-3 p-6">
        <h1 className="font-mono text-[13px] tracking-[0.22em] text-ink">Connect Rhumb</h1>
        <p className="text-[13px] text-muted">
          {scanning ? "Scanning your tailnet for Rhumb servers…" : found.length > 0 ? "Found on your tailnet:" : "No Rhumb servers found on your tailnet."}
        </p>
        {found.map((h) => (
          <button
            key={h.baseUrl}
            type="button"
            disabled={busy}
            onClick={() => void connect(h.baseUrl)}
            aria-label={`Connect to ${hostname(h.baseUrl)}`}
            className="flex items-center justify-between border border-line bg-panel px-3 py-2 text-left hover:bg-raised disabled:opacity-40"
          >
            <span className="mn">{hostname(h.baseUrl)}</span>
            <span className="text-[12.5px] text-muted">v{h.version}</span>
          </button>
        ))}
        {!scanning && found.length === 0 && report && (
          <div className="text-[12.5px] text-muted" data-testid="discovery-diagnostic">
            <p>
              Scanned {report.scanned} tailnet {report.scanned === 1 ? "peer" : "peers"} — none responded as Rhumb.
            </p>
            {report.attempts.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer">Details</summary>
                <ul className="mt-1 space-y-0.5">
                  {report.attempts.map((a, i) => (
                    <li key={i} className="mn">
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
          <button type="button" onClick={() => void scan()} className="self-start text-[12.5px] text-muted underline">
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
          <label htmlFor="server" className="ey">
            Server URL
          </label>
          <input
            id="server"
            placeholder="https://box.your-tailnet.ts.net"
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            className="mn border border-line-strong bg-bg px-2.5 py-2 text-[12.5px] outline-none placeholder:text-faint focus:border-accent"
          />
          <button
            type="submit"
            disabled={busy || manualUrl.trim() === ""}
            className="rounded-sm bg-accent px-4 py-2.5 text-[13px] text-bg disabled:opacity-40"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
        {error && (
          <p role="alert" className="border border-danger/50 bg-danger/10 px-2 py-1.5 text-[12.5px] text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
