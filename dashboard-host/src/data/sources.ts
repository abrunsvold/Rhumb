import { readFileSync, existsSync } from "node:fs";
import type { DataSource } from "./types.js";

const ID_RE = /^[A-Za-z0-9._-]+$/;

function isValid(raw: unknown): raw is DataSource {
  if (typeof raw !== "object" || raw === null) return false;
  const s = raw as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    ID_RE.test(s.id) &&
    s.type === "postgres" &&
    (s.mode === "read" || s.mode === "read-write") &&
    typeof s.connectionString === "string" &&
    s.connectionString.length > 0
  );
}

export function loadDataSources(path: string): DataSource[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValid);
}

export function findSource(sources: DataSource[], id: string): DataSource | undefined {
  return sources.find((s) => s.id === id);
}
