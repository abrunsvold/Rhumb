import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface TrustPair {
  source: string;
  surfaceId: string;
  // Who created this standing rule, and when (review F3). In a shared room a
  // grant auto-executes OTHER people's future writes, so "someone trusted this
  // surface" has to answer who. Optional: pairs written before attribution
  // existed stay valid — a missing granter reads as "unknown, pre-rooms",
  // never as a reason to drop the grant.
  grantedBy?: string;
  grantedAt?: string;
}

export function loadTrust(path: string): TrustPair[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is TrustPair =>
        typeof p === "object" && p !== null &&
        typeof (p as TrustPair).source === "string" &&
        typeof (p as TrustPair).surfaceId === "string",
    );
  } catch {
    return [];
  }
}

export function isTrusted(trust: TrustPair[], source: string, surfaceId: string | null): boolean {
  if (surfaceId === null) return false;
  return trust.some((p) => p.source === source && p.surfaceId === surfaceId);
}

export function addTrust(path: string, pair: TrustPair): TrustPair[] {
  const current = loadTrust(path);
  if (current.some((p) => p.source === pair.source && p.surfaceId === pair.surfaceId)) {
    return current;
  }
  const next = [...current, pair];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2));
  return next;
}
