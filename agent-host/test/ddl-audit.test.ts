import { describe, it, expect } from "vitest";
import { DDL_AUDIT_STATEMENTS, ensureDdlAudit } from "../src/infra/ddlAudit.js";
import type { AdminExecutor } from "../src/infra/types.js";

const all = DDL_AUDIT_STATEMENTS.join("\n---\n");

describe("DDL_AUDIT_STATEMENTS", () => {
  it("creates the dedicated _rhumb schema first and revokes PUBLIC access", () => {
    expect(DDL_AUDIT_STATEMENTS[0]).toContain("CREATE SCHEMA IF NOT EXISTS _rhumb");
    expect(all).toContain("REVOKE ALL ON SCHEMA _rhumb FROM PUBLIC");
  });

  it("creates the audit table idempotently, schema-qualified into _rhumb", () => {
    expect(all).toContain("CREATE TABLE IF NOT EXISTS _rhumb.ddl_audit");
  });

  it("defines both trigger functions as SECURITY DEFINER with a pinned search_path", () => {
    for (const fn of ["_rhumb.log_ddl()", "_rhumb.log_drop()"]) {
      const stmt = DDL_AUDIT_STATEMENTS.find((s) => s.includes(`FUNCTION ${fn}`));
      expect(stmt, `function ${fn}`).toBeDefined();
      expect(stmt!).toContain("CREATE OR REPLACE FUNCTION");
      expect(stmt!).toContain("SECURITY DEFINER");
      expect(stmt!).toContain("SET search_path = pg_catalog, _rhumb");
      expect(stmt!).toContain("_rhumb.ddl_audit");
    }
  });

  it("records session_user as the actor, not current_user", () => {
    expect(all).toContain("session_user");
    expect(all).not.toContain("current_user");
  });

  it("installs both event triggers via drop-then-create (idempotent), referencing the _rhumb functions", () => {
    for (const trg of ["_rhumb_ddl_audit_end", "_rhumb_ddl_audit_drop"]) {
      const dropIdx = DDL_AUDIT_STATEMENTS.findIndex((s) => s.includes(`DROP EVENT TRIGGER IF EXISTS ${trg}`));
      const createIdx = DDL_AUDIT_STATEMENTS.findIndex((s) => s.includes(`CREATE EVENT TRIGGER ${trg}`));
      expect(dropIdx, `drop ${trg}`).toBeGreaterThanOrEqual(0);
      expect(createIdx, `create ${trg}`).toBeGreaterThanOrEqual(0);
      expect(createIdx).toBe(dropIdx + 1);
    }
    const endStmt = DDL_AUDIT_STATEMENTS.find((s) => s.includes("CREATE EVENT TRIGGER _rhumb_ddl_audit_end"));
    const dropStmt = DDL_AUDIT_STATEMENTS.find((s) => s.includes("CREATE EVENT TRIGGER _rhumb_ddl_audit_drop"));
    expect(endStmt).toContain("ON ddl_command_end");
    expect(endStmt).toContain("_rhumb.log_ddl()");
    expect(dropStmt).toContain("ON sql_drop");
    expect(dropStmt).toContain("_rhumb.log_drop()");
  });

  it("orders install schema -> table -> functions -> triggers", () => {
    const idx = (needle: string) => DDL_AUDIT_STATEMENTS.findIndex((s) => s.includes(needle));
    const schema = idx("CREATE SCHEMA IF NOT EXISTS _rhumb");
    const revoke = idx("REVOKE ALL ON SCHEMA _rhumb FROM PUBLIC");
    const table = idx("CREATE TABLE IF NOT EXISTS _rhumb.ddl_audit");
    const fnDdl = idx("FUNCTION _rhumb.log_ddl()");
    const fnDrop = idx("FUNCTION _rhumb.log_drop()");
    const trgEnd = idx("CREATE EVENT TRIGGER _rhumb_ddl_audit_end");
    const trgDrop = idx("CREATE EVENT TRIGGER _rhumb_ddl_audit_drop");

    expect(schema).toBe(0);
    expect(schema).toBeLessThan(revoke);
    expect(revoke).toBeLessThan(table);
    expect(table).toBeLessThan(fnDdl);
    expect(table).toBeLessThan(fnDrop);
    expect(fnDdl).toBeLessThan(trgEnd);
    expect(fnDrop).toBeLessThan(trgDrop);
  });
});

describe("ensureDdlAudit", () => {
  it("runs every statement, in order", async () => {
    const seen: string[] = [];
    const exec: AdminExecutor = { async exec(sql) { seen.push(sql); } };
    await ensureDdlAudit(exec);
    expect(seen).toEqual([...DDL_AUDIT_STATEMENTS]);
  });

  it("propagates an executor error (aborts the install)", async () => {
    const exec: AdminExecutor = { async exec() { throw new Error("no perms"); } };
    await expect(ensureDdlAudit(exec)).rejects.toThrow("no perms");
  });
});
