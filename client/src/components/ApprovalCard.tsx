import { useState } from "react";
import type { PendingItem } from "../lib/pendingStore";
import { summarizeOp } from "../lib/opSummary";

function isDelete(item: PendingItem): boolean {
  return item.origin === "data" && (item.op as { kind?: string } | null)?.kind === "delete";
}

export function ApprovalCard({
  item,
  onResolve,
}: {
  item: PendingItem;
  onResolve: (decision: "approve" | "deny", trust: boolean) => void;
}) {
  const [trust, setTrust] = useState(false);
  const [open, setOpen] = useState(false);
  // Infra actions have no trust concept at all, and the server re-gates a
  // DELETE even on a trusted surface — so neither may offer the checkbox.
  const trustable = item.origin === "data" && !!item.surfaceId && !isDelete(item);

  return (
    <div className="flex max-w-[60ch] flex-col gap-3.5 border-l border-warn pl-3.5">
      <div className="text-[14.5px] leading-[1.75] text-ink-soft">{summarizeOp(item)}</div>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="self-start text-left text-[12.5px] text-faint">
        <span className="border-b border-line-strong text-muted">{open ? "hide details" : "details"}</span>
      </button>
      {open && (
        <pre className="max-h-56 overflow-auto border border-line bg-panel p-2 font-mono text-xs text-muted">
          {JSON.stringify(item.op ?? null, null, 2)}
        </pre>
      )}
      {trustable && (
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
          Trust this surface — future adds and edits from it run without asking
        </label>
      )}
      {isDelete(item) && (
        <span className="text-[12.5px] leading-relaxed text-warn">
          Deletions always come back for approval, even on a trusted surface.
        </span>
      )}
      <div className="flex flex-wrap items-center gap-3.5">
        <button
          onClick={() => onResolve("approve", trust)}
          className="flex-none whitespace-nowrap rounded-sm bg-accent px-4 py-2.5 text-[13px] text-bg"
        >
          Approve
        </button>
        <button
          onClick={() => onResolve("deny", false)}
          className="flex-none whitespace-nowrap rounded-sm border border-line-strong px-4 py-2.5 text-[13px] text-muted"
        >
          Not yet
        </button>
        <span className="min-w-0 flex-1 text-[12.5px] text-faint">
          {item.origin === "data"
            ? `guardrail: ${item.surfaceId ?? "unattributed surface"} · ${item.source ?? "unknown source"}`
            : "runs on the box once approved"}
        </span>
      </div>
    </div>
  );
}
