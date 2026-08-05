import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMngrAgentIdResolver, fleetGatedToolNames, fleetServerKey, makeFleetCanUseTool } from "../src/index.js";
import { PendingActions } from "../src/infra/pending.js";
import { createAgentRegistry } from "../src/agents.js";
import { createFleetServer, FLEET_TOOL_NAMES, GATED_FLEET_TOOL_NAMES } from "../src/fleet/server.js";
import type { FleetOps } from "../src/fleet/ops.js";
import { loadFleetEnabled } from "../src/config.js";

describe("fleet gating wiring", () => {
  it("includes mcp__fleet__spawn in the gated tool set", () => {
    expect(fleetGatedToolNames()).toContain("mcp__fleet__spawn");
  });

  it("does not gate the read-only fleet tools", () => {
    expect(fleetGatedToolNames()).not.toContain("mcp__fleet__check");
    expect(fleetGatedToolNames()).not.toContain("mcp__fleet__collect");
  });
});

// F1: the registration key, the tool names the SDK will publish, and the set
// the approval gate matches on must not be able to drift apart. If they do,
// `spawn` registers under a name the gate does not contain and the gate falls
// through to ALLOW — silently, with every other test still green.
describe("fleetServerKey (registration key <-> gated names binding)", () => {
  const noopOps: FleetOps = { spawn: async () => [], check: async () => [], collect: async () => [] };
  const server = createFleetServer(noopOps, () => ({ parentAgentId: null, depth: 0 }));

  it("returns the name the server was actually constructed with", () => {
    expect(fleetServerKey(server)).toBe(server.name);
  });

  it("every gated name is a tool the constructed server really registers", () => {
    // Same private-field read `test/fleet-server.test.ts` uses — this is the
    // only channel to what the SDK will publish.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = Object.keys((server.instance as any)._registeredTools).map(
      (name) => `mcp__${fleetServerKey(server)}__${name}`,
    );
    for (const gated of GATED_FLEET_TOOL_NAMES) expect(registered).toContain(gated);
    expect([...FLEET_TOOL_NAMES].sort()).toEqual(registered.sort());
  });

  it("refuses to produce a key when the server name and the gated names disagree", () => {
    // Exactly the drift the guard exists for: someone renames the MCP server
    // (or the constants) and leaves the other side alone.
    expect(() => fleetServerKey({ name: "swarm" })).toThrow(/renamed|never produce/);
    expect(() => fleetServerKey({ name: "" })).toThrow();
  });
});

// F3: the kill switch. Fleet activation must be an explicit operator choice,
// not a side effect of mngr being on PATH.
describe("loadFleetEnabled", () => {
  it("is OFF when unset", () => {
    expect(loadFleetEnabled({})).toBe(false);
    expect(loadFleetEnabled({ RHUMB_FLEET_ENABLED: "" })).toBe(false);
  });

  it("is ON only for recognised truthy values", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(loadFleetEnabled({ RHUMB_FLEET_ENABLED: v })).toBe(true);
    }
    for (const v of ["0", "false", "no", "off"]) {
      expect(loadFleetEnabled({ RHUMB_FLEET_ENABLED: v })).toBe(false);
    }
  });

  it("fails closed and warns on an unrecognised value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadFleetEnabled({ RHUMB_FLEET_ENABLED: "enabled-please" })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0] as string).toContain("RHUMB_FLEET_ENABLED");
    warn.mockRestore();
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
