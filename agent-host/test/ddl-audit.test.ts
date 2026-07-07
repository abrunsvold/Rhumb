import { describe, it, expect } from "vitest";
import { DDL_AUDIT_STATEMENTS, ensureDdlAudit } from "../src/infra/ddlAudit.js";
import type { AdminExecutor } from "../src/infra/types.js";

const all = DDL_AUDIT_STATEMENTS.join("\n---\n");

describe("DDL_AUDIT_STATEMENTS", () => {
  it("creates the audit table idempotently, schema-qualified", () => {
    expect(all).toContain("CREATE TABLE IF NOT EXISTS public._rhumb_ddl_audit");
  });

  it("defines both trigger functions as SECURITY DEFINER with a pinned search_path", () => {
    for (const fn of ["public._rhumb_log_ddl()", "public._rhumb_log_drop()"]) {
      const stmt = DDL_AUDIT_STATEMENTS.find((s) => s.includes(`FUNCTION ${fn}`));
      expect(stmt, `function ${fn}`).toBeDefined();
      expect(stmt!).toContain("CREATE OR REPLACE FUNCTION");
      expect(stmt!).toContain("SECURITY DEFINER");
      expect(stmt!).toContain("SET search_path = pg_catalog, public");
      expect(stmt!).toContain("public._rhumb_ddl_audit");
    }
  });

  it("records session_user as the actor, not current_user", () => {
    expect(all).toContain("session_user");
    expect(all).not.toContain("current_user");
  });

  it("installs both event triggers via drop-then-create (idempotent)", () => {
    for (const trg of ["_rhumb_ddl_audit_end", "_rhumb_ddl_audit_drop"]) {
      expect(all).toContain(`DROP EVENT TRIGGER IF EXISTS ${trg}`);
      expect(all).toContain(`CREATE EVENT TRIGGER ${trg}`);
    }
    expect(all).toContain("ON ddl_command_end");
    expect(all).toContain("ON sql_drop");
  });

  it("orders install table -> functions -> triggers", () => {
    const idx = (needle: string) => DDL_AUDIT_STATEMENTS.findIndex((s) => s.includes(needle));
    const table = idx("CREATE TABLE IF NOT EXISTS public._rhumb_ddl_audit");
    const fn = idx("FUNCTION public._rhumb_log_ddl()");
    const trg = idx("CREATE EVENT TRIGGER _rhumb_ddl_audit_end");
    expect(table).toBeGreaterThanOrEqual(0);
    expect(table).toBeLessThan(fn);
    expect(fn).toBeLessThan(trg);
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
