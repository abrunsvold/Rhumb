import type { PendingItem } from "./pendingStore";

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
