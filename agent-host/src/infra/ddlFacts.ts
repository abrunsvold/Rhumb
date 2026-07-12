import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../fsAtomic.js";

export interface DdlSourceFacts {
  installed: boolean;
  count7d?: number;
  lastTs?: string;
  lastTag?: string;
  lastObject?: string;
  lastActor?: string;
}

export interface DdlFacts {
  fetchedAt: string;
  sources: Record<string, DdlSourceFacts>;
}

// The audit table is superuser-owned by design (the owner role can neither
// read nor tamper with it), so queryDb must carry admin credentials.
export function createDdlFactsRefresher(deps: {
  readSources: () => Array<{ id: string; connectionString: string }>;
  queryDb: (dbName: string, sql: string) => Promise<Array<Record<string, unknown>>>;
  path: string;
  now: () => string;
}): () => Promise<DdlFacts> {
  return async function refresh(): Promise<DdlFacts> {
    const sources: Record<string, DdlSourceFacts> = {};
    for (const s of deps.readSources()) {
      let dbName: string;
      try {
        dbName = new URL(s.connectionString).pathname.slice(1);
      } catch { continue; }
      if (!dbName) continue;
      // Per-source degradation: a failing database is omitted (absent ≠ not-installed).
      try {
        const reg = await deps.queryDb(dbName, "SELECT to_regclass('_rhumb.ddl_audit') AS t");
        if (!reg[0]?.t) {
          sources[s.id] = { installed: false };
          continue;
        }
        const last = await deps.queryDb(
          dbName,
          "SELECT ts, actor, command_tag, object_identity FROM _rhumb.ddl_audit ORDER BY ts DESC LIMIT 1",
        );
        const count = await deps.queryDb(
          dbName,
          "SELECT count(*)::int AS n FROM _rhumb.ddl_audit WHERE ts > now() - interval '7 days'",
        );
        const entry: DdlSourceFacts = { installed: true, count7d: Number(count[0]?.n ?? 0) };
        const row = last[0];
        if (row) {
          if (row.ts != null) entry.lastTs = String(row.ts);
          if (row.command_tag != null) entry.lastTag = String(row.command_tag);
          if (row.object_identity != null) entry.lastObject = String(row.object_identity);
          if (row.actor != null) entry.lastActor = String(row.actor);
        }
        sources[s.id] = entry;
      } catch { /* omit this source */ }
    }
    const facts: DdlFacts = { fetchedAt: deps.now(), sources };
    atomicWriteFileSync(deps.path, JSON.stringify(facts, null, 2));
    return facts;
  };
}

export function readDdlFactsFile(path: string): DdlFacts | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DdlFacts;
    return typeof parsed?.fetchedAt === "string" && parsed?.sources && typeof parsed.sources === "object"
      ? parsed
      : null;
  } catch {
    return null;
  }
}
