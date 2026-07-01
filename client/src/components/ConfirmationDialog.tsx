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
    <div role="dialog" aria-label="Confirm action" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", color: "#111", padding: 20, borderRadius: 8, maxWidth: 480 }}>
        <h2>{current.origin === "data" ? `Write to "${current.source}"` : `Infrastructure: ${current.tool}`}</h2>
        {current.origin === "data" && <p>Surface: {current.surfaceId ?? "unknown"}</p>}
        <pre style={{ background: "#f3f4f6", padding: 8, overflow: "auto" }}>{JSON.stringify(current.op, null, 2)}</pre>
        {current.origin === "data" && (
          <label><input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} /> Trust this surface</label>
        )}
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button onClick={() => decide("approve")}>Approve</button>
          <button onClick={() => decide("deny")}>Deny</button>
        </div>
      </div>
    </div>
  );
}
