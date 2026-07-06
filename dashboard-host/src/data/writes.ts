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
): Promise<{ rowCount: number }> {
  try {
    const result = await deps.getExecutor(source).run(buildSql(op));
    appendAudit(deps.auditPath, {
      ts: deps.now(), source, surfaceId, op, decision: "executed", rowCount: result.rowCount, auth,
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
  | { status: "pending" }
  | { status: "executed"; result: { rowCount: number } }
  | { status: "denied" };

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

  async resolve(pendingId: string, decision: "approve" | "deny"): Promise<void> {
    const w = this.pending.get(pendingId);
    if (!w || this.status.get(pendingId)?.status !== "pending") return;
    if (decision === "approve") {
      const result = await executeWrite(this.deps, w.source, w.op, w.surfaceId, "approval");
      this.status.set(pendingId, { status: "executed", result });
    } else {
      appendAudit(this.deps.auditPath, {
        ts: this.deps.now(), source: w.source, surfaceId: w.surfaceId, op: w.op, decision: "denied",
      });
      this.status.set(pendingId, { status: "denied" });
    }
    for (const fn of this.listeners) fn("resolved", w);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
