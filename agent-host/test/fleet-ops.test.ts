import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFleetOps } from "../src/fleet/ops.js";
import { createAgentRegistry, type AgentRegistry } from "../src/agents.js";
import type { AgentBackend, AgentRef } from "../src/backends/types.js";

let dir: string;
let registry: AgentRegistry;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rhumb-fleet-"));
  let n = 0;
  registry = createAgentRegistry({
    indexPath: join(dir, "agents.json"),
    now: () => "2026-08-04T00:00:00.000Z",
    id: () => `rhumb-${++n}`,
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CAPS = { maxPerSpawn: 8, maxConcurrent: 8, maxDepth: 1 };
const SPEC = { model: "m", workspace: "/ws", permissionMode: "acceptEdits", extraOptions: {} };

/** Records sends; ensure() binds a fake nativeId. */
function fakeBackend(sent: Array<{ agentId: string; prompt: string }>): AgentBackend {
  return {
    id: "mngr",
    async ensure(agentId) {
      registry.bind(agentId, `agent-native-${agentId}`);
      return { agentId, nativeId: `agent-native-${agentId}`, backend: "mngr" };
    },
    async send(ref: AgentRef, prompt) {
      sent.push({ agentId: ref.agentId, prompt });
      return ref;
    },
    async list() { return []; },
    async stop() {},
    async transcript() { return null; },
  };
}

function makeOps(over: Partial<Parameters<typeof createFleetOps>[0]> = {}) {
  const sent: Array<{ agentId: string; prompt: string }> = [];
  const ops = createFleetOps({
    backend: fakeBackend(sent),
    registry,
    caps: CAPS,
    spec: SPEC,
    mintName: () => `fleet-${Math.random().toString(16).slice(2, 8)}`,
    liveness: async () => new Map(),
    lastFinishReason: async () => null,
    ...over,
  });
  return { ops, sent };
}

describe("fleet spawn", () => {
  it("creates one principal per task and dispatches each prompt", async () => {
    const { ops, sent } = makeOps();
    const out = await ops.spawn(
      [{ prompt: "task A" }, { prompt: "task B" }],
      { parentAgentId: null, depth: 0 },
    );
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.ok)).toBe(true);
    expect(sent.map((s) => s.prompt).sort()).toEqual(["task A", "task B"]);
    expect(registry.list()).toHaveLength(2);
  });

  it("records lineage on every spawned principal", async () => {
    const { ops } = makeOps();
    const out = await ops.spawn([{ prompt: "x" }], { parentAgentId: "rhumb-parent", depth: 0 });
    const id = (out[0] as { ok: true; agentId: string }).agentId;
    const rec = registry.get(id);
    expect(rec?.parentAgentId).toBe("rhumb-parent");
    expect(rec?.depth).toBe(1);
  });

  it("REJECTS the whole batch on a cap breach, creating ZERO principals", async () => {
    const { ops, sent } = makeOps({ caps: { ...CAPS, maxPerSpawn: 1 } });
    await expect(
      ops.spawn([{ prompt: "a" }, { prompt: "b" }], { parentAgentId: null, depth: 0 }),
    ).rejects.toThrow(/limit 1 per spawn/);
    expect(registry.list()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("isolates a per-task failure without failing the batch", async () => {
    const sent: Array<{ agentId: string; prompt: string }> = [];
    const backend = fakeBackend(sent);
    const failing: AgentBackend = {
      ...backend,
      async send(ref, prompt) {
        if (prompt === "boom") throw new Error("spawn refused");
        return backend.send(ref, prompt, () => {});
      },
    };
    const { ops } = makeOps({ backend: failing });
    const out = await ops.spawn([{ prompt: "ok" }, { prompt: "boom" }], { parentAgentId: null, depth: 0 });
    expect(out.filter((o) => o.ok)).toHaveLength(1);
    const failed = out.find((o) => !o.ok) as { ok: false; error: string };
    expect(failed.error).toMatch(/spawn refused/);
  });
});

describe("fleet check/collect", () => {
  it("reports per-agent status", async () => {
    const { ops } = makeOps({
      liveness: async () => new Map([["agent-native-rhumb-1", { state: "WAITING", idleSeconds: 30 }]]),
      lastFinishReason: async () => "stop_sequence",
    });
    const out = await ops.spawn([{ prompt: "x" }], { parentAgentId: null, depth: 0 });
    const id = (out[0] as { ok: true; agentId: string }).agentId;
    expect(await ops.check([id])).toEqual([{ agentId: id, status: "done" }]);
  });

  it("collect returns PARTIAL results with status rather than throwing on timeout", async () => {
    const { ops } = makeOps({
      liveness: async () => new Map([["agent-native-rhumb-1", { state: "RUNNING", idleSeconds: 0 }]]),
      lastFinishReason: async () => null,
      pollIntervalMs: 1,
    });
    const out = await ops.spawn([{ prompt: "x" }], { parentAgentId: null, depth: 0 });
    const id = (out[0] as { ok: true; agentId: string }).agentId;
    const collected = await ops.collect([id], 20);
    expect(collected).toEqual([{ agentId: id, status: "working", result: null }]);
  });
});
