import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../fsAtomic.js";
import type { PendingAction, GatedTool, PendingMode, Proposer } from "./types.js";

type ListenerKind = "added" | "resolved" | "executed" | "failed";
type Listener = (kind: ListenerKind, a: PendingAction) => void;

interface Entry {
  action: PendingAction;
  resolve: (d: "approve" | "deny") => void;
  settled: boolean;
}

export class PendingActions {
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly persistPath?: string;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<Listener>();

  constructor(deps: { now: () => string; id: () => string; persistPath?: string }) {
    this.now = deps.now;
    this.id = deps.id;
    this.persistPath = deps.persistPath;
    this.load();
  }

  // Boot rules: a blocking entry's promise died with the process — expire it.
  // A parked pending entry survives and stays approvable. A parked entry that
  // was approved but never completed is marked failed, never re-executed.
  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    let stored: PendingAction[];
    try {
      stored = JSON.parse(readFileSync(this.persistPath, "utf8")) as PendingAction[];
      if (!Array.isArray(stored)) return;
    } catch { return; }
    for (const action of stored) {
      if (action.status === "pending" && action.mode === "blocking") {
        action.status = "expired";
      } else if (action.status === "approved" && action.mode === "parked") {
        action.status = "failed";
        action.error = "host restarted during execution";
      }
      this.entries.set(action.pendingId, { action, resolve: () => {}, settled: action.status !== "pending" });
    }
    this.save();
  }

  private save(): void {
    if (!this.persistPath) return;
    const all = [...this.entries.values()].map((e) => e.action);
    atomicWriteFileSync(this.persistPath, JSON.stringify(all, null, 2));
  }

  enqueue(
    tool: GatedTool,
    input: Record<string, unknown>,
    opts?: { mode?: PendingMode; proposedBy?: Proposer },
  ): { action: PendingAction; decision: Promise<"approve" | "deny"> } {
    const action: PendingAction = {
      pendingId: this.id(), tool, input, createdAt: this.now(),
      mode: opts?.mode ?? "blocking",
      status: "pending",
      proposedBy: opts?.proposedBy ?? "interactive",
    };
    let resolveFn!: (d: "approve" | "deny") => void;
    const decision = new Promise<"approve" | "deny">((res) => { resolveFn = res; });
    this.entries.set(action.pendingId, { action, resolve: resolveFn, settled: false });
    this.save();
    for (const fn of this.listeners) fn("added", action);
    return { action, decision };
  }

  resolve(pendingId: string, decision: "approve" | "deny"): boolean {
    const entry = this.entries.get(pendingId);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    entry.action.status = decision === "approve" ? "approved" : "denied";
    entry.action.resolvedAt = this.now();
    entry.resolve(decision);
    this.save();
    for (const fn of this.listeners) fn("resolved", entry.action);
    return true;
  }

  // Terminal state of an approved parked action, once its background
  // execution finishes (or throws).
  recordOutcome(pendingId: string, outcome: "executed" | "failed", detail: string): boolean {
    const entry = this.entries.get(pendingId);
    if (!entry || entry.action.status !== "approved") return false;
    entry.action.status = outcome;
    if (outcome === "executed") entry.action.result = detail;
    else entry.action.error = detail;
    this.save();
    for (const fn of this.listeners) fn(outcome, entry.action);
    return true;
  }

  get(pendingId: string): PendingAction | undefined {
    return this.entries.get(pendingId)?.action;
  }

  list(): PendingAction[] {
    return [...this.entries.values()].filter((e) => e.action.status === "pending").map((e) => e.action);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
