import type { PendingAction, GatedTool } from "./types.js";

type Listener = (kind: "added" | "resolved", a: PendingAction) => void;

interface Entry {
  action: PendingAction;
  resolve: (d: "approve" | "deny") => void;
  settled: boolean;
}

export class PendingActions {
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<Listener>();

  constructor(deps: { now: () => string; id: () => string }) {
    this.now = deps.now;
    this.id = deps.id;
  }

  enqueue(tool: GatedTool, input: Record<string, unknown>): { action: PendingAction; decision: Promise<"approve" | "deny"> } {
    const action: PendingAction = { pendingId: this.id(), tool, input, createdAt: this.now() };
    let resolveFn!: (d: "approve" | "deny") => void;
    const decision = new Promise<"approve" | "deny">((res) => { resolveFn = res; });
    this.entries.set(action.pendingId, { action, resolve: resolveFn, settled: false });
    for (const fn of this.listeners) fn("added", action);
    return { action, decision };
  }

  resolve(pendingId: string, decision: "approve" | "deny"): boolean {
    const entry = this.entries.get(pendingId);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    entry.resolve(decision);
    for (const fn of this.listeners) fn("resolved", entry.action);
    return true;
  }

  list(): PendingAction[] {
    return [...this.entries.values()].filter((e) => !e.settled).map((e) => e.action);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
