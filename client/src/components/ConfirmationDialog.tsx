import { useEffect, useState } from "react";
import { reducePending, type PendingItem } from "../lib/pendingStore";
import { openPendingStream, resolvePending, openInfraPendingStream, resolveInfraPending } from "../lib/tauri";

export function ConfirmationDialog({ agentBase, dashboardBase }: { agentBase: string; dashboardBase: string }) {
  const [queue, setQueue] = useState<PendingItem[]>([]);
  const [trust, setTrust] = useState(false);

  useEffect(() => {
    const stopData = openPendingStream(dashboardBase, (e) => setQueue((p) => reducePending(p, e, "data")));
    const stopInfra = openInfraPendingStream(agentBase, (e) => setQueue((p) => reducePending(p, e, "infra")));
    return () => { stopData(); stopInfra(); };
  }, [agentBase, dashboardBase]);

  const current = queue[0];
  if (!current) return null;

  async function decide(decision: "approve" | "deny") {
    if (current.origin === "data") {
      await resolvePending(dashboardBase, current.pendingId, decision, decision === "approve" && trust);
    } else {
      await resolveInfraPending(agentBase, current.pendingId, decision);
    }
    setQueue((p) => p.filter((x) => x.pendingId !== current.pendingId));
    setTrust(false);
  }

  return (
    <div role="dialog" aria-label="Confirm action" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-lg border border-line bg-panel p-5 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">
            {current.origin === "data" ? `Write to "${current.source}"` : `Infrastructure: ${current.tool}`}
          </h2>
          {queue.length > 1 && (
            <span className="ml-auto rounded-full bg-raised border border-line px-2 py-0.5 text-xs text-muted">
              {queue.length} pending
            </span>
          )}
        </div>
        {current.origin === "data" && <p className="text-xs text-muted">Surface: {current.surfaceId ?? "unknown"}</p>}
        <pre className="max-h-56 overflow-auto rounded border border-line bg-raised p-2 font-mono text-xs">
          {JSON.stringify(current.op, null, 2)}
        </pre>
        {current.origin === "data" && (
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
            Trust this surface
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={() => decide("deny")} className="rounded border border-line px-3 py-1.5 text-muted hover:text-ink">
            Deny
          </button>
          <button onClick={() => decide("approve")} className="rounded bg-accent px-3 py-1.5 font-medium text-white">
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
