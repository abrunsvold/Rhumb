import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { SurfaceMeta, RegistrySnapshot } from "./types.js";

const ID_RE = /^[A-Za-z0-9._-]+$/;

export function readSurfaceMeta(dir: string): SurfaceMeta | null {
  const file = join(dir, "surface.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const folder = basename(dir);
  if (
    typeof m.id !== "string" ||
    m.id !== folder ||
    !ID_RE.test(m.id) ||
    m.kind !== "file" ||
    typeof m.title !== "string" ||
    typeof m.entry !== "string" ||
    m.entry.length === 0 ||
    typeof m.created !== "string" ||
    typeof m.updated !== "string"
  ) {
    return null;
  }
  return {
    id: m.id,
    title: m.title,
    kind: "file",
    entry: m.entry,
    created: m.created,
    updated: m.updated,
  };
}

export function scanSurfaces(root: string): SurfaceMeta[] {
  if (!existsSync(root)) return [];
  const out: SurfaceMeta[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const meta = readSurfaceMeta(dir);
    if (meta) out.push(meta);
  }
  return out;
}

export function toSnapshot(metas: SurfaceMeta[]): RegistrySnapshot {
  return {
    surfaces: metas.map((m) => ({
      id: m.id,
      title: m.title,
      url: `/surfaces/${m.id}/`,
      kind: m.kind,
      created: m.created,
      updated: m.updated,
    })),
  };
}
