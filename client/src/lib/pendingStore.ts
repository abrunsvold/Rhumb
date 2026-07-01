export interface PendingItem {
  origin: "data" | "infra";
  pendingId: string;
  source?: string;        // data
  op?: unknown;           // data op or infra input
  surfaceId?: string | null; // data
  tool?: string;          // infra
}

export function reducePending(list: PendingItem[], event: unknown, origin: "data" | "infra"): PendingItem[] {
  if (typeof event !== "object" || event === null) return list;
  const e = event as { type?: string; write?: Record<string, unknown>; action?: Record<string, unknown> };
  const raw = e.write ?? e.action;
  if (!raw || typeof raw.pendingId !== "string") return list;
  if (e.type === "added") {
    if (list.some((x) => x.pendingId === raw.pendingId)) return list;
    const item: PendingItem =
      origin === "data"
        ? { origin, pendingId: raw.pendingId as string, source: raw.source as string, op: raw.op, surfaceId: (raw.surfaceId ?? null) as string | null }
        : { origin, pendingId: raw.pendingId as string, tool: raw.tool as string, op: raw.input };
    return [...list, item];
  }
  if (e.type === "resolved") return list.filter((x) => x.pendingId !== raw.pendingId);
  return list;
}
