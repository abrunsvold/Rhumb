import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCanUseTool, GATED_TOOLS, createInfraServer, type InfraDeps } from "../src/infra/server.js";
import { PendingActions } from "../src/infra/pending.js";
import type { ServiceOps } from "../src/services/ops.js";

// Minimal no-op ServiceOps stub; individual tests override the methods they exercise.
const fakeServiceOps: ServiceOps = {
  spawn: async () => { throw new Error("not implemented"); },
  redeploy: async () => { throw new Error("not implemented"); },
  stop: async () => {},
  start: async () => {},
  destroy: async () => {},
  list: () => [],
  status: () => undefined,
};

// Invokes a registered infra tool's handler directly (bypassing MCP transport/zod
// validation, which the SDK's own executeToolHandler also skips for a valid-shaped
// input) so tests can assert on tool bodies without standing up a real MCP server.
async function callTool(name: string, args: Record<string, unknown>, deps: Partial<InfraDeps>): Promise<string> {
  const server = createInfraServer({
    proxmox: {} as InfraDeps["proxmox"],
    admin: {} as InfraDeps["admin"],
    dataSourcesPath: "",
    auditPath: "",
    now: () => "T",
    password: () => "x",
    ...deps,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registered = (server.instance as any)._registeredTools[name];
  const result = await registered.handler(args, {});
  return result.content.map((c: { text: string }) => c.text).join("\n");
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-gate-")); });
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

  it("fails closed (deny + error audit) if the decision promise rejects", async () => {
    const auditPath = join(dir, "a.jsonl");
    const fakePending = {
      enqueue: () => ({ action: { pendingId: "x", tool: "destroy_vm", input: {}, createdAt: "T" }, decision: Promise.reject(new Error("boom")) }),
    } as unknown as PendingActions;
    const canUse = makeCanUseTool({ pending: fakePending, auditPath, now: () => "T" });
    const r = await canUse("mcp__infra__destroy_vm", { id: 1 }, {} as never);
    expect(r.behavior).toBe("deny");
    expect(JSON.parse(readFileSync(auditPath, "utf8").trim()).decision).toBe("error");
  });

  it("GATED_TOOLS includes VM and service destructive/provisioning tools", () => {
    expect([...GATED_TOOLS].sort()).toEqual(
      ["create_vm", "destroy_service", "destroy_vm", "provision_database", "redeploy_service", "resize_vm", "spawn_service", "start_service", "start_vm", "stop_service", "stop_vm"].sort(),
    );
  });

  it("gates spawn_service through the pending queue", async () => {
    const pending = new PendingActions({ now: () => "T", id: () => "a1" });
    const canUse = makeCanUseTool({ pending, auditPath: join(dir, "a.jsonl"), now: () => "T" });
    const promise = canUse("mcp__infra__spawn_service", { id: "sales" }, {} as never);
    expect(pending.list().map((p) => p.tool)).toEqual(["spawn_service"]);
    pending.resolve("a1", "approve");
    expect((await promise).behavior).toBe("allow");
  });

  it("redeploy_service is gated, calls ops.redeploy, and surfaces the warning", async () => {
    expect(GATED_TOOLS).toContain("redeploy_service");
    const calls: string[] = [];
    const serviceOps: ServiceOps = {
      ...fakeServiceOps,
      redeploy: async (id: string) => {
        calls.push(id);
        return {
          entry: { id, name: id, containerId: 200, host: "h", port: 3000, basePath: `/services/${id}`, status: "healthy", createdAt: "T", deployId: "NEW", updatedAt: "T1" },
          warning: "cutover complete, but destroying the OLD container 105 failed: boom — clean it up manually (pct stop/destroy 105)",
        };
      },
    };
    const res = await callTool("redeploy_service", { id: "sales" }, { serviceOps });
    expect(calls).toEqual(["sales"]);
    expect(res).toContain("NEW");
    expect(res).toContain("WARNING");
    expect(res).toContain("105");
  });
});
