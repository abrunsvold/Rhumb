import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMngrAgentIdResolver, fleetGatedToolNames, makeFleetCanUseTool } from "../src/index.js";
import { PendingActions } from "../src/infra/pending.js";
import { createAgentRegistry } from "../src/agents.js";

describe("fleet gating wiring", () => {
  it("includes mcp__fleet__spawn in the gated tool set", () => {
    expect(fleetGatedToolNames()).toContain("mcp__fleet__spawn");
  });

  it("does not gate the read-only fleet tools", () => {
    expect(fleetGatedToolNames()).not.toContain("mcp__fleet__check");
    expect(fleetGatedToolNames()).not.toContain("mcp__fleet__collect");
  });
});

describe("makeFleetCanUseTool", () => {
  let dir: string;
  let auditPath: string;
  let pending: PendingActions;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhumb-fleet-wiring-"));
    auditPath = join(dir, "infra-audit.jsonl");
    let n = 0;
    // No persistPath: the queue's on-disk behaviour is infra-pending's own
    // test's business, not this one's.
    pending = new PendingActions({ now: () => "2026-08-04T00:00:00.000Z", id: () => `pend-${++n}` });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const gate = (next?: Parameters<typeof makeFleetCanUseTool>[0]["next"]) =>
    makeFleetCanUseTool({ pending, auditPath, now: () => "2026-08-04T00:00:00.000Z", next });

  const auditLines = () =>
    existsSync(auditPath)
      ? readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  it("queues mcp__fleet__spawn for the operator and allows it once approved", async () => {
    const decision = gate()("mcp__fleet__spawn", { tasks: [{ prompt: "a" }, { prompt: "b" }] }, {});
    const queued = pending.list();
    expect(queued).toHaveLength(1);
    expect(queued[0].tool).toBe("mcp__fleet__spawn");
    // The operator sees the FULL input in the dialog, not the summary the
    // audit records.
    expect((queued[0].input.tasks as unknown[]).length).toBe(2);

    pending.resolve(queued[0].pendingId, "approve");
    expect(await decision).toEqual({ behavior: "allow", updatedInput: { tasks: [{ prompt: "a" }, { prompt: "b" }] } });

    expect(auditLines()).toEqual([
      // Task prompts are deliberately absent — shape only.
      { ts: "2026-08-04T00:00:00.000Z", tool: "mcp__fleet__spawn", input: { taskCount: 2 }, decision: "approved" },
    ]);
  });

  it("denies a spawn the operator rejects, and audits the denial", async () => {
    const decision = gate()("mcp__fleet__spawn", { tasks: [{ prompt: "a" }] }, {});
    pending.resolve(pending.list()[0].pendingId, "deny");
    const result = await decision;
    expect(result.behavior).toBe("deny");
    expect(auditLines()[0]).toMatchObject({ decision: "denied", tool: "mcp__fleet__spawn", input: { taskCount: 1 } });
  });

  it("never queues check or collect — polling must not need approval", async () => {
    for (const tool of ["mcp__fleet__check", "mcp__fleet__collect"]) {
      expect(await gate()(tool, { agentIds: ["a"] }, {})).toEqual({
        behavior: "allow",
        updatedInput: { agentIds: ["a"] },
      });
    }
    expect(pending.list()).toHaveLength(0);
    expect(auditLines()).toHaveLength(0);
  });

  it("chains every non-fleet tool to the infra gate when one is configured", async () => {
    const seen: string[] = [];
    const next = async (toolName: string) => {
      seen.push(toolName);
      return { behavior: "deny" as const, message: "infra said no" };
    };
    expect(await gate(next)("mcp__infra__destroy_vm", { id: 1 }, {})).toEqual({
      behavior: "deny",
      message: "infra said no",
    });
    expect(seen).toEqual(["mcp__infra__destroy_vm"]);
    // The fleet gate must not delegate ITS tool to the infra gate — the infra
    // gate allows every name it does not recognise, which is exactly the
    // ungated spawn this wiring exists to prevent.
    const decision = gate(next)("mcp__fleet__spawn", { tasks: [] }, {});
    pending.resolve(pending.list()[0].pendingId, "deny");
    await decision;
    expect(seen).toEqual(["mcp__infra__destroy_vm"]);
  });

  it("allows non-fleet tools when infra is not configured (no next in the chain)", async () => {
    expect(await gate()("Read", { file_path: "/x" }, {})).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/x" },
    });
  });
});

// The fleet and the RHUMB_AGENT_BACKEND=mngr foreground path now share ONE
// registry instance over one agents.json (two instances would overwrite each
// other's records — see buildApp). That puts fleet CHILDREN into the same
// unbound pool the operator-conversation resolver recycles from.
describe("createMngrAgentIdResolver with fleet children in the registry", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("never adopts an unbound fleet child for an operator conversation", () => {
    dir = mkdtempSync(join(tmpdir(), "rhumb-fleet-lineage-"));
    let n = 0;
    let t = 0;
    const registry = createAgentRegistry({
      indexPath: join(dir, "agents.json"),
      now: () => new Date(2026, 7, 4, 0, 0, t++).toISOString(),
      id: () => `agent-${++n}`,
    });
    // A fleet child: minted by ops.spawn at depth 1, unbound until `mngr
    // create` returns — the exact window an operator turn could steal it in.
    const child = registry.create("fleet-abc", "mngr", { parentAgentId: null, depth: 1 });

    const resolved = createMngrAgentIdResolver(registry, { mintDisplayName: () => "rhumb-fresh" })(undefined);

    expect(resolved.agentId).not.toBe(child.agentId);
    expect(registry.get(resolved.agentId)?.depth).toBe(0);
    // The child is still there, untouched and still unbound.
    expect(registry.get(child.agentId)?.nativeId).toBeNull();
  });
});
