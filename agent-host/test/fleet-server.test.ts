import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  FLEET_TOOL_NAMES,
  GATED_FLEET_TOOL_NAMES,
  createFleetServer,
  preAllowedFleetToolNames,
} from "../src/fleet/server.js";
import type { FleetOps, SpawnContext } from "../src/fleet/ops.js";

const noopOps: FleetOps = {
  spawn: async () => [],
  check: async () => [],
  collect: async () => [],
};

describe("fleet server", () => {
  it("exposes exactly spawn, check, collect", () => {
    expect([...FLEET_TOOL_NAMES].sort()).toEqual([
      "mcp__fleet__check",
      "mcp__fleet__collect",
      "mcp__fleet__spawn",
    ]);
  });

  // F1: FLEET_TOOL_NAMES/GATED_FLEET_TOOL_NAMES are hand-maintained constants
  // with nothing structurally tying them to what createFleetServer actually
  // registers — a fourth tool or a server rename could silently drift the
  // constants away from reality with no test failing. This derives the truth
  // from the constructed server itself (the same `_registeredTools` shape
  // the SDK's own request handler reads from — see McpServer.setToolRequestHandlers
  // in @anthropic-ai/claude-agent-sdk's sdk.mjs) and asserts the exported
  // constants match it exactly, so adding/renaming a tool without updating
  // the constants fails HERE rather than silently leaving the new tool
  // neither allow-listed nor gated.
  it("FLEET_TOOL_NAMES matches exactly what the server registers, prefixed mcp__fleet__", () => {
    const server = createFleetServer(noopOps, () => ({ parentAgentId: null, depth: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registeredNames = Object.keys((server.instance as any)._registeredTools).map(
      (name) => `mcp__fleet__${name}`,
    );
    expect([...FLEET_TOOL_NAMES].sort()).toEqual(registeredNames.sort());
    for (const gated of GATED_FLEET_TOOL_NAMES) {
      expect(FLEET_TOOL_NAMES).toContain(gated);
    }
  });

  it("gates spawn and ONLY spawn", () => {
    expect(GATED_FLEET_TOOL_NAMES.has("mcp__fleet__spawn")).toBe(true);
    expect(GATED_FLEET_TOOL_NAMES.has("mcp__fleet__check")).toBe(false);
    expect(GATED_FLEET_TOOL_NAMES.has("mcp__fleet__collect")).toBe(false);
  });

  // Review test-gap: buildApp pre-allows exactly this list on the SDK's
  // allowedTools. `spawn` MUST be absent — a pre-allowed tool is approved by
  // the SDK without ever consulting canUseTool, so listing spawn here would
  // silently remove the operator gate while every other test stayed green.
  // Deleting the filter inside preAllowedFleetToolNames turns this red.
  it("pre-allows ONLY the ungated fleet tools — spawn must fall through to the operator gate", () => {
    expect([...preAllowedFleetToolNames()].sort()).toEqual(["mcp__fleet__check", "mcp__fleet__collect"]);
    expect(preAllowedFleetToolNames()).not.toContain("mcp__fleet__spawn");
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
    // F3: the thunk returns a DIFFERENT value on each call (an incrementing
    // depth) rather than a fixed constant. A fixed-value thunk can't tell
    // `ctx()` called fresh per-call apart from a refactor that hoists it to
    // `const c = ctx()` once at construction time and reuses `c` for every
    // subsequent call — both would satisfy a single-call, fixed-ctx
    // assertion. Task 7 depends on per-call derivation (the calling agent's
    // real depth changes call to call), so this test calls the handler
    // twice and asserts ops.spawn observed two DISTINCT ctx values, which a
    // hoisted `ctx()` call cannot produce.
    let depth = 0;
    const ctx = () => ({ parentAgentId: "parent-1", depth: ++depth });
    const server = createFleetServer(ops, ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = (server.instance as any)._registeredTools["spawn"];
    // Simulate a model trying to smuggle depth/parentAgentId through the
    // arguments object directly (bypassing schema stripping entirely, the
    // worst case). The handler must still ignore them and use ctx().
    await registered.handler({ tasks: [{ prompt: "hi" }], depth: 0, parentAgentId: "root" }, {});
    await registered.handler({ tasks: [{ prompt: "bye" }], depth: 99, parentAgentId: "root" }, {});

    expect(seenTasks).toEqual([[{ prompt: "hi" }], [{ prompt: "bye" }]]);
    expect(seenCtx).toEqual([
      { parentAgentId: "parent-1", depth: 1 },
      { parentAgentId: "parent-1", depth: 2 },
    ]);
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

  // F2: a cap breach (zero principals minted) must be UNMISTAKABLE to the
  // model, not merely structurally distinct (an error object vs. an array)
  // inside an otherwise-successful (non-isError) tool result. Matches the
  // `fail()` precedent in src/ontology/server.ts and src/infra/server.ts.
  it("spawn surfaces a thrown cap-breach error as isError:true, not a disguised success", async () => {
    const ops: FleetOps = {
      spawn: async () => { throw new Error("cap breached: would exceed maxConcurrent=8"); },
      check: async () => [],
      collect: async () => [],
    };
    const server = createFleetServer(ops, () => ({ parentAgentId: null, depth: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = (server.instance as any)._registeredTools["spawn"];
    const result = await registered.handler({ tasks: [{ prompt: "hi" }] }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cap breached");
  });

  it("check surfaces a thrown ops error as isError:true", async () => {
    const ops: FleetOps = {
      spawn: async () => [],
      check: async () => { throw new Error("registry unreadable"); },
      collect: async () => [],
    };
    const server = createFleetServer(ops, () => ({ parentAgentId: null, depth: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = (server.instance as any)._registeredTools["check"];
    const result = await registered.handler({ agentIds: ["a1"] }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("registry unreadable");
  });

  it("collect surfaces a thrown ops error as isError:true", async () => {
    const ops: FleetOps = {
      spawn: async () => [],
      check: async () => [],
      collect: async () => { throw new Error("liveness probe failed"); },
    };
    const server = createFleetServer(ops, () => ({ parentAgentId: null, depth: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = (server.instance as any)._registeredTools["collect"];
    const result = await registered.handler({ agentIds: ["a1"] }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("liveness probe failed");
  });

  // Final review, I1: the descriptions used to tell the MODEL something
  // better than the truth — `check` advertised the full status vocabulary and
  // `collect` described returning real results, while src/index.ts wires
  // liveness/lastFinishReason to `async () => null`, so `check` can only
  // report "unknown" and `collect` can never return a result. A model that
  // believes the old text spawns a fleet, polls forever, and gives up —
  // leaving real Claude Code processes running unobserved on the operator's
  // box with the concurrency cap spent. These assertions keep the tools from
  // quietly over-promising again; they are expected to be updated (not
  // deleted) in the same change that lands real liveness.
  it("check's description states that status is always \"unknown\" in this build and points at mngr", () => {
    const server = createFleetServer(noopOps, () => ({ parentAgentId: null, depth: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const description = (server.instance as any)._registeredTools["check"].description as string;
    expect(description).toContain("LIMITATION OF THIS BUILD");
    expect(description).toContain('"unknown"');
    expect(description).toContain("mngr");
  });

  it("collect's description states that it returns no results in this build and points at mngr", () => {
    const server = createFleetServer(noopOps, () => ({ parentAgentId: null, depth: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const description = (server.instance as any)._registeredTools["collect"].description as string;
    expect(description).toContain("LIMITATION OF THIS BUILD");
    expect(description).toContain("NO RESULTS AT ALL");
    expect(description).toContain("mngr");
  });

  it("spawn's description warns that spawned agents are never reaped and permanently consume the cap", () => {
    const server = createFleetServer(noopOps, () => ({ parentAgentId: null, depth: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const description = (server.instance as any)._registeredTools["spawn"].description as string;
    expect(description).toContain("never reaped");
    expect(description.toLowerCase()).toContain("concurrency cap");
  });

  // Final review, I2: `placement` is now REJECTED rather than silently
  // discarded, so the schema must say so where the model reads it.
  it("spawn's placement field is documented as local-only", () => {
    const server = createFleetServer(noopOps, () => ({ parentAgentId: null, depth: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = (server.instance as any)._registeredTools["spawn"];
    const schema = registered.inputSchema as z.ZodObject<Record<string, z.ZodTypeAny>>;
    // z.array(z.object({...})) -> element shape
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const placement = (schema.shape.tasks as any).element.shape.placement;
    expect(placement.description).toContain("LOCAL ONLY");
    expect(placement.description).toContain("ok:false");
  });

  it("spawn's description documents the per-task {ok,error} result shape", () => {
    const server = createFleetServer(noopOps, () => ({ parentAgentId: null, depth: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = (server.instance as any)._registeredTools["spawn"];
    expect(registered.description).toMatch(/ok\s*:\s*false/);
    expect(registered.description.toLowerCase()).toContain("error");
  });
});
