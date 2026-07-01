import type { ServiceManifest } from "./types.js";

const ID = /^[A-Za-z0-9._-]+$/;

export function validateManifest(raw: unknown): ServiceManifest {
  if (typeof raw !== "object" || raw === null) throw new Error("manifest must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id)) throw new Error(`invalid service id: ${String(r.id)}`);
  if (typeof r.name !== "string" || r.name.length === 0) throw new Error("manifest.name is required");
  if (typeof r.start !== "string" || r.start.length === 0) throw new Error("manifest.start is required");
  if (typeof r.port !== "number" || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) {
    throw new Error("manifest.port must be an integer 1-65535");
  }
  const out: ServiceManifest = { id: r.id, type: "service", name: r.name, start: r.start, port: r.port };
  if (r.resources && typeof r.resources === "object") {
    const res = r.resources as Record<string, unknown>;
    out.resources = {};
    if (typeof res.cores === "number") out.resources.cores = res.cores;
    if (typeof res.memory === "number") out.resources.memory = res.memory;
  }
  return out;
}
