import { useState } from "react";
import type { PendingItem, ResolvedItem } from "../lib/pendingStore";
import { summarizeOp, isDelete } from "../lib/opSummary";

// The approval queue, rendered both inside a transcript and — when no session
// is open — on its own. It lives in one place because a pending write must
// stay reachable in every state the middle column can be in: the queue is
// server-side, so a card the client fails to draw is a write left held with no
// way to approve or deny it.
export function ApprovalQueue({
  pending,
  resolved,
  onResolve,
}: {
  pending: PendingItem[];
  resolved: ResolvedItem[];
  // May return a promise: ApprovalCard awaits it to keep its buttons disabled
  // for exactly as long as the resolve round-trip is in flight.
  onResolve: (item: PendingItem, decision: "approve" | "deny", trust: boolean) => void | Promise<void>;
}) {
  return (
    // A pending write arrives unannounced — the operator may be typing in the
    // composer or reading further up the transcript. The ConfirmationDialog
    // this queue replaced was a `role="dialog"` that took focus; nothing
    // replaced its announcement, so the region is polite-live instead.
    //
    // Rendered unconditionally, INCLUDING when empty. A live region announces
    // an insertion only if it was already in the accessibility tree; a region
    // created and filled in the same mutation is the case assistive tech drops.
    // An earlier version carried `empty:hidden` to keep the empty wrapper out
    // of the parent's `gap-6` flow, which was self-defeating: that compiles to
    // `display: none`, which removes the element from the accessibility tree
    // entirely, so the region did not pre-exist its content after all. The
    // accepted cost of dropping it is one `gap-6` (24px) of trailing space
    // below the last transcript entry. Do not re-add a rule that hides this
    // element while it is empty.
    <div aria-live="polite" className="flex flex-col gap-6">
      {/* Keyed by position as well as id: a failed resolve records an outcome
          while leaving the pending in place, so one pendingId can legitimately
          produce several entries (each retry) and ids alone are not unique. */}
      {resolved.map((r, i) => (
        <div key={`${r.pendingId}:${i}`} data-kind="resolved" className="flex max-w-[60ch] flex-col gap-1.5 border-l border-line pl-3.5">
          <span className="text-[14.5px] leading-[1.75] text-ink-soft">{r.summary}</span>
          <span className="text-[12.5px] leading-relaxed text-faint">{r.outcome}</span>
        </div>
      ))}
      {/* Keyed by pendingId, never by index: `trust` is per-card useState, and
          an index key would let a ticked box slide onto whichever pending takes
          the slot when an earlier one resolves — granting standing trust on an
          op the operator never saw. */}
      {pending.map((p) => (
        <ApprovalCard key={p.pendingId} item={p} onResolve={(d, t) => onResolve(p, d, t)} />
      ))}
    </div>
  );
}

export function ApprovalCard({
  item,
  onResolve,
}: {
  item: PendingItem;
  onResolve: (decision: "approve" | "deny", trust: boolean) => void | Promise<void>;
}) {
  const [trust, setTrust] = useState(false);
  const [open, setOpen] = useState(false);
  // The resolve round-trip is async and this card stays mounted until it
  // settles. Without this guard a double-click issues two resolve calls for
  // the same pendingId: the host 500s the second (the pending is already
  // resolved) and the transcript records both "Approved…" and "Could not
  // resolve…" for one write. Cleared in `finally` because a FAILED resolve
  // leaves the pending in place for retry — the card must come back to life.
  const [busy, setBusy] = useState(false);
  async function decide(decision: "approve" | "deny", trustFlag: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await onResolve(decision, trustFlag);
    } finally {
      setBusy(false);
    }
  }
  // Infra actions have no trust concept at all, and the server re-gates a
  // DELETE even on a trusted surface — so neither may offer the checkbox.
  const trustable = item.origin === "data" && !!item.surfaceId && !isDelete(item);

  return (
    // Named by the same sentence the card leads with, so a screen reader
    // reaching this group says WHAT is being asked before the buttons.
    <div
      role="group"
      aria-label={summarizeOp(item)}
      className="flex max-w-[60ch] flex-col gap-3.5 border-l border-warn pl-3.5"
    >
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
          onClick={() => void decide("approve", trust)}
          disabled={busy}
          className="flex-none whitespace-nowrap rounded-sm bg-accent px-4 py-2.5 text-[13px] text-bg disabled:opacity-40"
        >
          Approve
        </button>
        <button
          onClick={() => void decide("deny", false)}
          disabled={busy}
          className="flex-none whitespace-nowrap rounded-sm border border-line-strong px-4 py-2.5 text-[13px] text-muted disabled:opacity-40"
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
