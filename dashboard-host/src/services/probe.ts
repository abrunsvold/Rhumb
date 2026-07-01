import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { ServiceEntry } from "./registry.js";

export async function probeOnce(deps: {
  getServices: () => Array<Pick<ServiceEntry, "id" | "host" | "port">>;
  probe: (s: { id: string; host: string; port: number }) => Promise<boolean>;
  writeStatus: (id: string, status: "healthy" | "unhealthy") => void;
}): Promise<void> {
  for (const s of deps.getServices()) {
    const ok = await deps.probe(s);
    deps.writeStatus(s.id, ok ? "healthy" : "unhealthy");
  }
}

// Real probe: a TCP/HTTP reachability check against the container's port.
export async function tcpProbe(s: { host: string; port: number }): Promise<boolean> {
  try {
    const res = await fetch(`http://${s.host}:${s.port}/`, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch { return false; }
}

// Update a service's status in services.json in place.
export function makeStatusWriter(servicesPath: string) {
  return (id: string, status: "healthy" | "unhealthy"): void => {
    if (!existsSync(servicesPath)) return;
    let list: ServiceEntry[];
    try { const raw = JSON.parse(readFileSync(servicesPath, "utf8")); list = Array.isArray(raw) ? raw : []; } catch { return; }
    const next = list.map((s) => (s.id === id ? { ...s, status } : s));
    writeFileSync(servicesPath, JSON.stringify(next, null, 2));
  };
}

export function startProbe(
  deps: Parameters<typeof probeOnce>[0],
  intervalMs: number,
): { stop(): void } {
  const timer = setInterval(() => void probeOnce(deps), intervalMs);
  if (typeof timer === "object" && "unref" in timer) (timer as { unref(): void }).unref();
  return { stop: () => clearInterval(timer) };
}
