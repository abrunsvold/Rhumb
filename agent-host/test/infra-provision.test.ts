import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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

  beforeEach(() => { admin.sqls = []; });

  it("runs CREATE statements, builds a source, and registers it", async () => {
    const entry = await provisionDatabase(
      { admin, dataSourcesPath: join(dir, "ds.json"), password: () => "pw123" },
      "reports",
    );
    expect(admin.sqls.some((s) => s.includes('CREATE ROLE "reports"'))).toBe(true);
    expect(admin.sqls.some((s) => s.includes('CREATE DATABASE "reports"'))).toBe(true);
    expect(entry).toMatchObject({ id: "reports", type: "postgres", mode: "read-write" });
    expect(entry.connectionString).toContain("reports");
    expect(JSON.parse(readFileSync(join(dir, "ds.json"), "utf8"))).toHaveLength(1);
  });

  it("rejects an invalid database name", async () => {
    await expect(
      provisionDatabase({ admin, dataSourcesPath: join(dir, "ds.json"), password: () => "pw" }, "bad; drop"),
    ).rejects.toThrow(/identifier/);
  });

  it("rejects a password containing a single quote", async () => {
    await expect(
      provisionDatabase({ admin, dataSourcesPath: join(dir, "ds.json"), password: () => "bad'pw" }, "ok"),
    ).rejects.toThrow(/password/);
  });
});
