import type { PendingItem } from "./pendingStore";

// Whether a pending is a row deletion. Lives here rather than in ApprovalCard
// because two places need it: the card hides the trust checkbox, and Workspace
// refuses to put `trust=true` on the wire. `dashboard-host/src/data/router.ts`
// re-gates a delete with `op.kind !== "delete"` but its addTrust does NOT look
// at op kind at all, so an ("approve", true) on a delete would still record a
// standing insert/update grant.
//
// Deliberately fail-open on an unrecognized op kind: this mirrors the host's
// `op.kind !== "delete"` byte-for-byte. A client stricter than the host would
// promise a gate the host does not enforce.
export function isDelete(item: PendingItem): boolean {
  return item.origin === "data" && (item.op as { kind?: string } | null)?.kind === "delete";
}

// One plain sentence for the approval card headline. Deliberately does NOT
// state a row count: the pending payload carries a WHERE clause, not a
// matched-row count, and guessing one would misrepresent the blast radius.
export function summarizeOp(item: PendingItem): string {
  if (item.origin === "infra") {
    const base = `Run ${item.tool ?? "an infrastructure action"}`;
    return item.proposedBy === "watchdog" ? `${base} (proposed by the watchdog)` : base;
  }
  const source = item.source ?? "the data source";
  const op = item.op as { kind?: string; table?: string } | null;
  if (!op || typeof op.kind !== "string" || typeof op.table !== "string") {
    return `Write to ${source}`;
  }
  const target = `${source}.${op.table}`;
  switch (op.kind) {
    case "insert": return `Add a row to ${target}`;
    case "update": return `Update rows in ${target}`;
    case "delete": return `Delete rows from ${target}`;
    default: return `Write to ${source}`;
  }
}
