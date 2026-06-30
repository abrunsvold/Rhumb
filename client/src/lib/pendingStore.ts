export interface PendingItem {
  pendingId: string;
  source: string;
  op: unknown;
  surfaceId: string | null;
}

export function reducePending(list: PendingItem[], event: unknown): PendingItem[] {
  if (typeof event !== "object" || event === null) return list;
  const e = event as { type?: string; write?: PendingItem };
  if (e.type === "added" && e.write) {
    if (list.some((x) => x.pendingId === e.write!.pendingId)) return list;
    return [...list, e.write];
  }
  if (e.type === "resolved" && e.write) {
    return list.filter((x) => x.pendingId !== e.write!.pendingId);
  }
  return list;
}
