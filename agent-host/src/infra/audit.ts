import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { InfraAuditEntry } from "./types.js";

export function appendInfraAudit(path: string, entry: InfraAuditEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n");
}
