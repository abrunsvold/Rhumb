import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceManifest } from "./types.js";

const ID = /^[A-Za-z0-9._-]+$/;

export function assertServiceId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !ID.test(id) || id === "." || id === "..") {
    throw new Error(`invalid service id: ${String(id)}`);
  }
}

export function validateManifest(raw: unknown): ServiceManifest {
  if (typeof raw !== "object" || raw === null) throw new Error("manifest must be an object");
  const r = raw as Record<string, unknown>;
  assertServiceId(r.id);
  if (typeof r.name !== "string" || r.name.length === 0) throw new Error("manifest.name is required");
  if (typeof r.start !== "string" || r.start.length === 0) throw new Error("manifest.start is required");
  if (typeof r.port !== "number" || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) {
    throw new Error("manifest.port must be an integer 1-65535");
  }
  const out: ServiceManifest = { id: r.id, type: "service", name: r.name, start: r.start, port: r.port };
  if (r.healthPath !== undefined) {
    if (typeof r.healthPath !== "string" || !r.healthPath.startsWith("/")) {
      throw new Error('manifest.healthPath must be a string starting with "/"');
    }
    out.healthPath = r.healthPath;
  }
  if (r.runtime !== undefined) {
    if (r.runtime !== "node" && r.runtime !== "python" && r.runtime !== "none") {
      throw new Error('manifest.runtime must be one of "node", "python", "none"');
    }
    out.runtime = r.runtime;
  }
  if (r.dataSources !== undefined) {
    if (!Array.isArray(r.dataSources) || r.dataSources.some((d) => typeof d !== "string" || !ID.test(d))) {
      throw new Error("manifest.dataSources must be an array of valid data-source ids");
    }
    out.dataSources = r.dataSources as string[];
  }
  if (r.resources && typeof r.resources === "object") {
    const res = r.resources as Record<string, unknown>;
    out.resources = {};
    if (typeof res.cores === "number") out.resources.cores = res.cores;
    if (typeof res.memory === "number") out.resources.memory = res.memory;
  }
  return out;
}

// Read a service manifest from <workspace>/services/<id>/service.json. The id is
// validated *before* it is joined into a path, so the guard sits at the
// filesystem boundary rather than relying on every caller to pre-validate.
export function readManifest(workspace: string, id: string): ServiceManifest {
  assertServiceId(id);
  return validateManifest(JSON.parse(readFileSync(join(workspace, "services", id, "service.json"), "utf8")));
}
