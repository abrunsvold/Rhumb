import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDdlFactsRefresher, readDdlFactsFile, type DdlFacts } from "../src/infra/ddlFacts.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-ddl-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sources = [
  { id: "sales", connectionString: "postgres://owner:pw@10.0.0.5:5432/sales_db" },
  { id: "printers", connectionString: "postgres://owner:pw@10.0.0.5:5432/printers" },
];

// A queryDb fake keyed by database name; the refresher probes to_regclass first.
function queryDbFake(perDb: Record<string, { installed: boolean; last?: Record<string, unknown>; count?: number }>) {
  return async (dbName: string, sql: string): Promise<Array<Record<string, unknown>>> => {
    const db = perDb[dbName];
    if (!db) throw new Error(`connect failed: ${dbName}`);
    if (sql.includes("to_regclass")) return [{ t: db.installed ? "_rhumb.ddl_audit" : null }];
    if (sql.includes("ORDER BY ts DESC")) return db.last ? [db.last] : [];
    if (sql.includes("count(*)")) return [{ n: db.count ?? 0 }];
    throw new Error(`unexpected sql: ${sql}`);
  };
}

function refresher(queryDb: (db: string, sql: string) => Promise<Array<Record<string, unknown>>>, path: string, src = sources) {
  return createDdlFactsRefresher({ readSources: () => src, queryDb, path, now: () => "T1" });
}

describe("createDdlFactsRefresher", () => {
  it("records history for installed sources and installed:false for pre-audit ones", async () => {
    const path = join(dir, "ddl-facts.json");
    const queryDb = queryDbFake({
      sales_db: {
        installed: true, count: 3,
        last: { ts: "2026-07-06T01:00:00Z", actor: "sales_owner", command_tag: "CREATE TABLE", object_identity: "public.spools" },
      },
      printers: { installed: false },
    });
    const facts = await refresher(queryDb, path)();
    expect(facts).toEqual({
      fetchedAt: "T1",
      sources: {
        sales: {
          installed: true, count7d: 3,
          lastTs: "2026-07-06T01:00:00Z", lastTag: "CREATE TABLE",
          lastObject: "public.spools", lastActor: "sales_owner",
        },
        printers: { installed: false },
      },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(facts);
  });

  it("handles an installed database with no DDL rows yet", async () => {
    const path = join(dir, "ddl-facts.json");
    const queryDb = queryDbFake({ sales_db: { installed: true, count: 0 }, printers: { installed: false } });
    const facts = await refresher(queryDb, path)();
    expect(facts.sources.sales).toEqual({ installed: true, count7d: 0 });
  });

  it("omits a source whose queries fail and skips unparsable connection strings", async () => {
    const path = join(dir, "ddl-facts.json");
    const src = [...sources, { id: "weird", connectionString: "not a url" }];
    const queryDb = queryDbFake({ sales_db: { installed: true, count: 1, last: { ts: "T", actor: "a", command_tag: "ALTER TABLE", object_identity: "o" } } });
    const facts = await refresher(queryDb, path, src)(); // printers db throws, weird unparsable
    expect(Object.keys(facts.sources)).toEqual(["sales"]);
  });
});

describe("readDdlFactsFile", () => {
  it("returns null for missing or corrupt files and parses valid ones", () => {
    const path = join(dir, "ddl-facts.json");
    expect(readDdlFactsFile(path)).toBeNull();
    writeFileSync(path, "{nope");
    expect(readDdlFactsFile(path)).toBeNull();
    const facts: DdlFacts = { fetchedAt: "T", sources: {} };
    writeFileSync(path, JSON.stringify(facts));
    expect(readDdlFactsFile(path)).toEqual(facts);
  });
});
