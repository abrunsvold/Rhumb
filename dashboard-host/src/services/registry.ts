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

export function loadServices(path: string): ServiceEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw : [];
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
