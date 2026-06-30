import { useEffect, useState } from "react";
import { reducePending, type PendingItem } from "../lib/pendingStore";
import { openPendingStream, resolvePending } from "../lib/tauri";

export function ConfirmationDialog({ dashboardBase }: { dashboardBase: string }) {
  const [queue, setQueue] = useState<PendingItem[]>([]);
  const [trust, setTrust] = useState(false);

  useEffect(() => {
    const stop = openPendingStream(dashboardBase, (event) => {
      setQueue((prev) => reducePending(prev, event));
    });
    return stop;
  }, [dashboardBase]);

  const current = queue[0];
  if (!current) return null;

  async function decide(decision: "approve" | "deny") {
    await resolvePending(dashboardBase, current.pendingId, decision, decision === "approve" && trust);
    setQueue((prev) => prev.filter((x) => x.pendingId !== current.pendingId));
    setTrust(false);
  }

  return (
    <div role="dialog" aria-label="Confirm write" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", color: "#111", padding: 20, borderRadius: 8, maxWidth: 480 }}>
        <h2>Confirm write to "{current.source}"</h2>
        <p>Surface: {current.surfaceId ?? "unknown"}</p>
        <pre style={{ background: "#f3f4f6", padding: 8, overflow: "auto" }}>{JSON.stringify(current.op, null, 2)}</pre>
        <label>
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} /> Trust this surface
        </label>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button onClick={() => decide("approve")}>Approve</button>
          <button onClick={() => decide("deny")}>Deny</button>
        </div>
      </div>
    </div>
  );
}
