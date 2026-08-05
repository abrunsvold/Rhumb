import { describe, it, expect } from "vitest";
import { z } from "zod";
import { FLEET_TOOL_NAMES, GATED_FLEET_TOOL_NAMES, createFleetServer } from "../src/fleet/server.js";
import type { FleetOps, SpawnContext } from "../src/fleet/ops.js";

describe("fleet server", () => {
  it("exposes exactly spawn, check, collect", () => {
    expect([...FLEET_TOOL_NAMES].sort()).toEqual([
      "mcp__fleet__check",
      "mcp__fleet__collect",
      "mcp__fleet__spawn",
    ]);
  });

  it("gates spawn and ONLY spawn", () => {
    expect(GATED_FLEET_TOOL_NAMES.has("mcp__fleet__spawn")).toBe(true);
    expect(GATED_FLEET_TOOL_NAMES.has("mcp__fleet__check")).toBe(false);
    expect(GATED_FLEET_TOOL_NAMES.has("mcp__fleet__collect")).toBe(false);
  });

  it("constructs without touching ops", () => {
    let called = false;
    const ops = {
      spawn: async () => { called = true; return []; },
      check: async () => [],
      collect: async () => [],
    };
    createFleetServer(ops, () => ({ parentAgentId: null, depth: 0 }));
    expect(called).toBe(false);
  });

  // Security-critical: SpawnContext (parentAgentId/depth) MUST be derived
  // server-side via the `ctx` thunk the host supplies, never trusted from
  // model-supplied tool arguments. If a model could pass `depth: 0` on the
  // spawn call, the depth cap would be trivially evaded by simply claiming
  // to be a root agent. This test asserts that at the schema level: the
  // registered `spawn` tool's zod shape has no `depth`/`parentAgentId`
  // field at all, and parsing a model-supplied payload that includes them
  // silently drops them rather than passing them through.
  it("spawn's input schema has no depth/parentAgentId field, and ignores them if supplied", () => {
    const ops: FleetOps = {
      spawn: async () => [],
      check: async () => [],
      collect: async () => [],
    };
    const server = createFleetServer(ops, () => ({ parentAgentId: null, depth: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = (server.instance as any)._registeredTools["spawn"];
    // The SDK registers `tool()`'s plain-object third argument as a real
    // ZodObject (`server.tool()` wraps it internally), so `inputSchema`
    // here is already `z.object({ tasks: ... })` — inspect its `.shape`.
    const schema = registered.inputSchema as z.ZodObject<Record<string, z.ZodTypeAny>>;
    const shape = schema.shape;

    expect(Object.keys(shape).sort()).toEqual(["tasks"]);
    expect(shape).not.toHaveProperty("depth");
    expect(shape).not.toHaveProperty("parentAgentId");

    const parsed = schema.parse({
      tasks: [{ prompt: "hi" }],
      depth: 0,
      parentAgentId: "root",
    });
    expect(parsed).toEqual({ tasks: [{ prompt: "hi" }] });
    expect(parsed).not.toHaveProperty("depth");
    expect(parsed).not.toHaveProperty("parentAgentId");
  });

  it("spawn calls ops.spawn with the tasks argument and a SEPARATE, server-derived ctx — never args", async () => {
    const seenCtx: SpawnContext[] = [];
    const seenTasks: unknown[] = [];
    const ops: FleetOps = {
      spawn: async (tasks, ctx) => {
        seenTasks.push(tasks);
        seenCtx.push(ctx);
        return tasks.map(() => ({ ok: true as const, agentId: "a1" }));
      },
      check: async () => [],
      collect: async () => [],
    };
    const fixedCtx: SpawnContext = { parentAgentId: "parent-1", depth: 3 };
    const server = createFleetServer(ops, () => fixedCtx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = (server.instance as any)._registeredTools["spawn"];
    // Simulate a model trying to smuggle depth/parentAgentId through the
    // arguments object directly (bypassing schema stripping entirely, the
    // worst case). The handler must still ignore them and use ctx().
    await registered.handler({ tasks: [{ prompt: "hi" }], depth: 0, parentAgentId: "root" }, {});

    expect(seenTasks).toEqual([[{ prompt: "hi" }]]);
    expect(seenCtx).toEqual([fixedCtx]);
  });

  it("check and collect forward to ops without requiring approval semantics", async () => {
    const ops: FleetOps = {
      spawn: async () => [],
      check: async (ids) => ids.map((id) => ({ agentId: id, status: "working" as const })),
      collect: async (ids) => ids.map((id) => ({ agentId: id, status: "working" as const, result: null })),
    };
    const server = createFleetServer(ops, () => ({ parentAgentId: null, depth: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server.instance as any)._registeredTools;

    const checkResult = await tools["check"].handler({ agentIds: ["a1"] }, {});
    expect(JSON.parse(checkResult.content[0].text)).toEqual([{ agentId: "a1", status: "working" }]);

    const collectResult = await tools["collect"].handler({ agentIds: ["a1"], waitMs: 1000 }, {});
    expect(JSON.parse(collectResult.content[0].text)).toEqual([{ agentId: "a1", status: "working", result: null }]);
  });

  it("spawn surfaces a thrown cap-breach error without throwing itself", async () => {
    const ops: FleetOps = {
      spawn: async () => { throw new Error("cap breached: would exceed maxConcurrent=8"); },
      check: async () => [],
      collect: async () => [],
    };
    const server = createFleetServer(ops, () => ({ parentAgentId: null, depth: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = (server.instance as any)._registeredTools["spawn"];
    const result = await registered.handler({ tasks: [{ prompt: "hi" }] }, {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("cap breached");
  });
});
