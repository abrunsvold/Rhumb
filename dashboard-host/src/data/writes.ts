import { buildSql } from "./sql.js";
import { appendAudit } from "./audit.js";
import type { DataOp, QueryExecutor, PendingWrite } from "./types.js";

export interface WriteDeps {
  getExecutor: (sourceId: string) => QueryExecutor;
  auditPath: string;
  now: () => string;
  id: () => string;
}

export async function executeWrite(
  deps: WriteDeps,
  source: string,
  op: DataOp,
  surfaceId: string | null,
  auth: "approval" | "trust",
  actor?: string,
): Promise<{ rowCount: number }> {
  try {
    const result = await deps.getExecutor(source).run(buildSql(op));
    appendAudit(deps.auditPath, {
      ts: deps.now(), source, surfaceId, op, decision: "executed", rowCount: result.rowCount, auth,
      ...(auth === "approval" && actor ? { actor } : {}),
    });
    return { rowCount: result.rowCount };
  } catch (err) {
    appendAudit(deps.auditPath, {
      ts: deps.now(), source, surfaceId, op, decision: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

type Status =
  | { status: "pending"; actor?: string }
  // Set synchronously, before executeWrite's await, the instant an approve is
  // accepted — see PendingQueue.resolve for why.
  | { status: "executing"; actor?: string }
  | { status: "executed"; result: { rowCount: number }; actor?: string }
  | { status: "denied"; actor?: string }
  | { status: "failed"; actor?: string };

export type ResolveResult = "ok" | "not-found" | "already-resolved";

type Listener = (kind: "added" | "resolved", w: PendingWrite) => void;

export class PendingQueue {
  private readonly deps: WriteDeps;
  private readonly pending = new Map<string, PendingWrite>();
  private readonly status = new Map<string, Status>();
  private readonly listeners = new Set<Listener>();

  constructor(deps: WriteDeps) {
    this.deps = deps;
  }

  enqueue(source: string, op: DataOp, surfaceId: string | null): PendingWrite {
    const w: PendingWrite = { pendingId: this.deps.id(), source, op, surfaceId, createdAt: this.deps.now() };
    this.pending.set(w.pendingId, w);
    this.status.set(w.pendingId, { status: "pending" });
    for (const fn of this.listeners) fn("added", w);
    return w;
  }

  get(pendingId: string): Status | undefined {
    return this.status.get(pendingId);
  }

  list(): PendingWrite[] {
    return [...this.pending.values()].filter((w) => this.status.get(w.pendingId)?.status === "pending");
  }

  async resolve(pendingId: string, decision: "approve" | "deny", actor?: string): Promise<ResolveResult> {
    const w = this.pending.get(pendingId);
    if (!w) return "not-found";
    if (this.status.get(pendingId)?.status !== "pending") return "already-resolved";
    if (decision === "approve") {
      // Transition out of "pending" synchronously, before the await below —
      // executeWrite does a real (awaited) DB round trip, and two concurrent
      // resolves must not both pass the pending check above and both run the
      // write. A second resolve arriving during the await now sees
      // "executing" (not "pending") at its own synchronous guard check and
      // bails as "already-resolved", mirroring agent-host's PendingActions,
      // which sets `settled = true` before its own async work.
      this.status.set(pendingId, { status: "executing" });
      try {
        const result = await executeWrite(this.deps, w.source, w.op, w.surfaceId, "approval", actor);
        this.status.set(pendingId, { status: "executed", result, ...(actor ? { actor } : {}) });
      } catch (err) {
        // executeWrite already appended an "error" audit entry and rethrows.
        // Land on a terminal "failed" state rather than reverting to
        // "pending" (a later resolve must not re-run this write) or silently
        // reporting "executed".
        this.status.set(pendingId, { status: "failed", ...(actor ? { actor } : {}) });
        for (const fn of this.listeners) fn("resolved", w);
        throw err;
      }
    } else {
      this.status.set(pendingId, { status: "denied", ...(actor ? { actor } : {}) });
      appendAudit(this.deps.auditPath, {
        ts: this.deps.now(), source: w.source, surfaceId: w.surfaceId, op: w.op, decision: "denied",
        ...(actor ? { actor } : {}),
      });
    }
    for (const fn of this.listeners) fn("resolved", w);
    return "ok";
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
