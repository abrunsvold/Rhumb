import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDataSource, provisionDatabase } from "../src/infra/provision.js";
import type { AdminExecutor } from "../src/infra/types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-prov-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("appendDataSource", () => {
  it("appends to an empty/missing file and dedupes by id", () => {
    const p = join(dir, "ds.json");
    const e = { id: "a", type: "postgres" as const, mode: "read-write" as const, connectionString: "x" };
    expect(appendDataSource(p, e)).toEqual([e]);
    expect(appendDataSource(p, e)).toEqual([e]); // dup id
    const arr = JSON.parse(readFileSync(p, "utf8"));
    expect(arr).toHaveLength(1);
  });

  it("preserves existing entries", () => {
    const p = join(dir, "ds.json");
    writeFileSync(p, JSON.stringify([{ id: "old", type: "postgres", mode: "read", connectionString: "y" }]));
    const out = appendDataSource(p, { id: "new", type: "postgres", mode: "read-write", connectionString: "z" });
    expect(out.map((s) => s.id)).toEqual(["old", "new"]);
  });

  it("treats a corrupt file as empty", () => {
    const p = join(dir, "ds.json");
    writeFileSync(p, "not json{");
    const e = { id: "a", type: "postgres" as const, mode: "read-write" as const, connectionString: "x" };
    expect(appendDataSource(p, e)).toEqual([e]);
  });
});

describe("provisionDatabase", () => {
  const admin: AdminExecutor & { sqls: string[] } = {
    sqls: [],
    async exec(sql: string) { (this as any).sqls.push(sql); },
  };
  // Per-DB superuser executor factory: capture what SQL runs against each DB.
  let dbExecs: Record<string, string[]>;
  let closedDbs: string[];
  const adminExecForDb = (db: string): AdminExecutor => ({
    async exec(sql: string) { (dbExecs[db] ??= []).push(sql); },
    async close() { closedDbs.push(db); },
  });

  beforeEach(() => { admin.sqls = []; dbExecs = {}; closedDbs = []; });

  it("runs CREATE statements, installs the DDL audit on the new DB, builds a source, and registers it", async () => {
    const entry = await provisionDatabase(
      { admin, adminExecForDb, dataSourcesPath: join(dir, "ds.json"), password: () => "pw123" },
      "reports",
    );
    expect(admin.sqls.some((s) => s.includes('CREATE DATABASE "reports"'))).toBe(true);
    // The event-trigger install ran against the NEW db's executor, not the admin (postgres) executor.
    expect((dbExecs["reports"] ?? []).some((s) => s.includes("CREATE EVENT TRIGGER _rhumb_ddl_audit_end"))).toBe(true);
    expect(admin.sqls.some((s) => s.includes("CREATE EVENT TRIGGER"))).toBe(false);
    expect(entry).toMatchObject({ id: "reports", type: "postgres", mode: "read-write" });
    expect(JSON.parse(readFileSync(join(dir, "ds.json"), "utf8"))).toHaveLength(1);
    // The per-DB executor's pool must be closed after a successful install.
    expect(closedDbs).toEqual(["reports"]);
  });

  it("aborts (does not register the source) if the audit install fails, but still closes the per-DB executor", async () => {
    const failingClosed: string[] = [];
    const failing = () => ({
      async exec() { throw new Error("event trigger denied"); },
      async close() { failingClosed.push("reports"); },
    });
    await expect(
      provisionDatabase(
        { admin, adminExecForDb: failing, dataSourcesPath: join(dir, "ds.json"), password: () => "pw" },
        "reports",
      ),
    ).rejects.toThrow("event trigger denied");
    expect(existsSync(join(dir, "ds.json"))).toBe(false);
    // Even though the install threw, the finally block must still close the pool.
    expect(failingClosed).toEqual(["reports"]);
  });

  it("rejects an invalid database name", async () => {
    await expect(
      provisionDatabase({ admin, adminExecForDb, dataSourcesPath: join(dir, "ds.json"), password: () => "pw" }, "bad; drop"),
    ).rejects.toThrow(/identifier/);
  });

  it("rejects a password containing a single quote", async () => {
    await expect(
      provisionDatabase({ admin, adminExecForDb, dataSourcesPath: join(dir, "ds.json"), password: () => "bad'pw" }, "ok"),
    ).rejects.toThrow(/password/);
  });
});
