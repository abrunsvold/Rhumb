import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync } from "../fsAtomic.js";
import type { ServiceEntry } from "./types.js";

export function loadServices(path: string): ServiceEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function write(path: string, list: ServiceEntry[]): ServiceEntry[] {
  atomicWriteFileSync(path, JSON.stringify(list, null, 2));
  return list;
}

export function appendService(path: string, entry: ServiceEntry): ServiceEntry[] {
  const cur = loadServices(path);
  if (cur.some((s) => s.id === entry.id)) throw new Error(`service "${entry.id}" already registered`);
  return write(path, [...cur, entry]);
}

export function replaceService(path: string, entry: ServiceEntry): ServiceEntry[] {
  const cur = loadServices(path);
  const i = cur.findIndex((s) => s.id === entry.id);
  if (i === -1) throw new Error(`service "${entry.id}" is not registered`);
  const next = [...cur];
  next[i] = entry;
  return write(path, next);
}

export function removeService(path: string, id: string): ServiceEntry[] {
  return write(path, loadServices(path).filter((s) => s.id !== id));
}
