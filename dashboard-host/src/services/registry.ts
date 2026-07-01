import { readFileSync, existsSync } from "node:fs";

export interface ServiceEntry {
  id: string;
  name: string;
  containerId: number;
  host: string;
  port: number;
  basePath: string;
  status: string;
  createdAt: string;
}

const ID_RE = /^[A-Za-z0-9._-]+$/;

// A service host is the IP of an agent-spawned container on the operator's
// private network. Reject the ranges that are never a legitimate container and
// are the classic SSRF targets: loopback (the dashboard host's own services)
// and link-local (169.254.0.0/16, incl. the cloud metadata endpoint).
export function isSafeServiceHost(host: string): boolean {
  if (typeof host !== "string" || host.length === 0) return false;
  const h = host.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "[::1]") return false;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 127) return false; // loopback 127.0.0.0/8
    if (a === 169 && b === 254) return false; // link-local 169.254.0.0/16
  }
  return true;
}

function isValidService(raw: unknown): raw is ServiceEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const s = raw as Record<string, unknown>;
  return (
    typeof s.id === "string" && ID_RE.test(s.id) &&
    typeof s.name === "string" &&
    typeof s.host === "string" && isSafeServiceHost(s.host) &&
    typeof s.port === "number" && Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535
  );
}

export function loadServices(path: string): ServiceEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw.filter(isValidService) : [];
  } catch { return []; }
}

export function serviceToRegistryEntry(s: ServiceEntry) {
  return {
    id: s.id,
    title: s.name,
    url: `/services/${s.id}/`,
    kind: "service" as const,
    created: s.createdAt,
    updated: s.createdAt,
    status: s.status,
  };
}
