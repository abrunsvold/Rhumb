import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ServiceEntry } from "./types.js";

export function loadServices(path: string): ServiceEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function write(path: string, list: ServiceEntry[]): ServiceEntry[] {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(list, null, 2));
  return list;
}

export function appendService(path: string, entry: ServiceEntry): ServiceEntry[] {
  const cur = loadServices(path);
  if (cur.some((s) => s.id === entry.id)) return cur;
  return write(path, [...cur, entry]);
}

export function removeService(path: string, id: string): ServiceEntry[] {
  return write(path, loadServices(path).filter((s) => s.id !== id));
}
