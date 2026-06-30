import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCanUseTool, GATED_TOOLS } from "../src/infra/server.js";
import { PendingActions } from "../src/infra/pending.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-gate-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("makeCanUseTool", () => {
  it("passes through (allows) a non-infra tool without enqueuing", async () => {
    const pending = new PendingActions({ now: () => "T", id: () => "a1" });
    const canUse = makeCanUseTool({ pending, auditPath: join(dir, "a.jsonl"), now: () => "T" });
    const r = await canUse("Bash", { command: "ls" }, {} as never);
    expect(r).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(pending.list()).toHaveLength(0);
  });

  it("gates a destructive infra tool: enqueues, awaits, then allows on approve + audits", async () => {
    const pending = new PendingActions({ now: () => "T", id: () => "a1" });
    const auditPath = join(dir, "a.jsonl");
    const canUse = makeCanUseTool({ pending, auditPath, now: () => "T" });

    const promise = canUse("mcp__infra__destroy_vm", { id: 9 }, {} as never);
    // it should be pending now
    expect(pending.list().map((p) => p.tool)).toEqual(["destroy_vm"]);
    pending.resolve("a1", "approve");
    const r = await promise;
    expect(r).toEqual({ behavior: "allow", updatedInput: { id: 9 } });
    expect(JSON.parse(readFileSync(auditPath, "utf8").trim())).toMatchObject({ tool: "mcp__infra__destroy_vm", decision: "approved" });
  });

  it("denies + audits when the operator denies", async () => {
    const pending = new PendingActions({ now: () => "T", id: () => "a1" });
    const auditPath = join(dir, "a.jsonl");
    const canUse = makeCanUseTool({ pending, auditPath, now: () => "T" });
    const promise = canUse("mcp__infra__create_vm", { name: "x" }, {} as never);
    pending.resolve("a1", "deny");
    const r = await promise;
    expect(r.behavior).toBe("deny");
    expect(JSON.parse(readFileSync(auditPath, "utf8").trim()).decision).toBe("denied");
  });

  it("GATED_TOOLS lists the six destructive/provisioning tools", () => {
    expect([...GATED_TOOLS].sort()).toEqual(
      ["create_vm", "destroy_vm", "provision_database", "resize_vm", "start_vm", "stop_vm"],
    );
  });
});
