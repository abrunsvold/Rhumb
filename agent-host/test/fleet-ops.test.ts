import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFleetOps, PLACEMENT_LOCAL_ONLY_ERROR } from "../src/fleet/ops.js";
import { createAgentRegistry, type AgentRegistry } from "../src/agents.js";
import type { AgentBackend, AgentRef } from "../src/backends/types.js";
import { EMPTY_COMPLETION_RESULT } from "../src/backends/mngr.js";

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

// Fix round 1: distinct values so a breach test can tell WHICH cap fired —
// the original 8/8 fixture couldn't distinguish maxPerSpawn from
// maxConcurrent.
const CAPS = { maxPerSpawn: 3, maxConcurrent: 8, maxDepth: 1 };
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

/** Waits out the fire-and-forget dispatch chain (I2: `spawn` no longer
 *  awaits `send`, so failures it discovers are recorded asynchronously,
 *  after `spawn` has already returned). Node drains ALL pending microtasks
 *  before firing a macrotask, so a single `setTimeout(0)` is enough to
 *  observe anything the dispatch chain has settled by then. */
function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
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

  it("REJECTS a batch that would exceed maxConcurrent (distinct from maxPerSpawn), minting nothing extra", async () => {
    // Fix round 1, I1: previously only maxPerSpawn was ever exercised.
    // maxPerSpawn is generous here (5) so only the CONCURRENT cap can fire.
    const { ops } = makeOps({ caps: { maxPerSpawn: 5, maxConcurrent: 2, maxDepth: 1 } });
    const first = await ops.spawn([{ prompt: "a" }, { prompt: "b" }], { parentAgentId: null, depth: 0 });
    expect(first.every((o) => o.ok)).toBe(true); // exactly fills the cap: 2/2

    await expect(
      ops.spawn([{ prompt: "c" }], { parentAgentId: null, depth: 0 }),
    ).rejects.toThrow(/limit 2 concurrent/);
    expect(registry.list()).toHaveLength(2); // the second batch minted NOTHING
  });

  it("spawn returns once every agent is ensured, WITHOUT waiting for send() to resolve (I2 dispatch-only)", async () => {
    let releaseSend: (() => void) | null = null;
    const backend = fakeBackend([]);
    const slow: AgentBackend = {
      ...backend,
      send(ref) {
        // A send() that would hang forever unless explicitly released —
        // if `spawn` awaited this, the test itself would time out.
        return new Promise((resolve) => {
          releaseSend = () => resolve(ref);
        });
      },
    };
    const { ops } = makeOps({ backend: slow });
    const started = Date.now();
    const out = await ops.spawn([{ prompt: "x" }], { parentAgentId: null, depth: 0 });
    expect(Date.now() - started).toBeLessThan(200);
    // M8: the expected agentId is read from the REGISTRY, not out of `out`
    // itself. `agentId: (out[0] as ...).agentId` was a tautology — it
    // compared the value under test against itself, so only `ok: true` was
    // really being asserted and a spawn that returned a bogus id would pass.
    expect(registry.list()).toHaveLength(1);
    expect(out).toEqual([{ ok: true, agentId: registry.list()[0].agentId }]);
    // Release the dangling send so it doesn't leak an unresolved promise
    // (and a potential unhandled-rejection warning) past this test.
    releaseSend?.();
    await flushMicrotasks();
  });

  it(
    "isolates a per-task ENSURE failure without failing the batch " +
      "(the realistic production failure mode: ensure() returns nativeId:null, it never throws)",
    async () => {
      const sent: Array<{ agentId: string; prompt: string }> = [];
      const backend = fakeBackend(sent);
      const failing: AgentBackend = {
        ...backend,
        async ensure(agentId, spec) {
          if (agentId === "rhumb-2") {
            // Matches the real mngr backend's failure shape: no throw, a
            // null nativeId plus a `reason` code.
            return { agentId, nativeId: null, backend: "mngr", reason: "create-failed" } as AgentRef;
          }
          return backend.ensure(agentId, spec);
        },
      };
      const { ops } = makeOps({ backend: failing });
      const out = await ops.spawn([{ prompt: "ok" }, { prompt: "boom" }], { parentAgentId: null, depth: 0 });
      expect(out.filter((o) => o.ok)).toHaveLength(1);
      const failed = out.find((o) => !o.ok) as { ok: false; error: string };
      expect(failed.error).toMatch(/create-failed/);
      // The failed principal is left ACTIVE and unbound (not markStopped),
      // so a later retry through ensureAgent's own adoption path could
      // still recover it — see the `dispatchOne` doc comment in ops.ts.
      expect(registry.get("rhumb-2")?.status).toBe("active");
      expect(sent).toHaveLength(1); // only the surviving task's prompt was sent
    },
  );
});

describe("fleet spawn placement (final review, I2)", () => {
  // Before this fix `placement` was declared on the tool schema, typed in
  // FleetTask, and read by NOTHING: a model asking for "the build box" got
  // ok:true and localhost agents, with no error and no log line.
  it("REJECTS a non-local placement per task, minting no principal and dispatching nothing for it", async () => {
    const { ops, sent } = makeOps();
    const out = await ops.spawn([{ prompt: "remote", placement: "build-box" }], {
      parentAgentId: null,
      depth: 0,
    });
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(false);
    // The exact contract string the README quotes, not a paraphrase.
    expect(PLACEMENT_LOCAL_ONLY_ERROR).toBe("placement is local-only in this release");
    expect((out[0] as { ok: false; error: string }).error).toContain(PLACEMENT_LOCAL_ONLY_ERROR);
    expect((out[0] as { ok: false; error: string }).error).toContain("build-box");
    expect(registry.list()).toHaveLength(0); // no principal minted
    expect(sent).toHaveLength(0); // nothing dispatched
  });

  it("rejects ONLY the offending task; the rest of the batch still spawns, in positional order", async () => {
    const { ops, sent } = makeOps();
    const out = await ops.spawn(
      [{ prompt: "a" }, { prompt: "b", placement: "somewhere-else" }, { prompt: "c" }],
      { parentAgentId: null, depth: 0 },
    );
    expect(out).toHaveLength(3);
    // Positional alignment matters: the model maps outcome N onto task N, so
    // a rejected task in the middle must not shift the others.
    expect(out[0].ok).toBe(true);
    expect(out[1].ok).toBe(false);
    expect(out[2].ok).toBe(true);
    expect(registry.list()).toHaveLength(2);
    expect(sent.map((s) => s.prompt).sort()).toEqual(["a", "c"]);
  });

  it("ACCEPTS an omitted, empty, or explicitly-local placement (the deliberate decision — see ops.ts)", async () => {
    // maxPerSpawn raised above the default fixture's 3: all four of these
    // must be ADMITTED, so the per-spawn cap must not be what refuses them.
    const { ops, sent } = makeOps({ caps: { ...CAPS, maxPerSpawn: 4 } });
    const out = await ops.spawn(
      [
        { prompt: "omitted" },
        { prompt: "empty", placement: "  " },
        { prompt: "local", placement: "local" },
        { prompt: "cased", placement: " LocalHost " },
      ],
      { parentAgentId: null, depth: 0 },
    );
    expect(out.every((o) => o.ok)).toBe(true);
    expect(sent).toHaveLength(4);
  });

  it("a placement-rejected task does NOT consume the per-spawn cap (it creates no agent)", async () => {
    // maxPerSpawn is 3 (CAPS). Four tasks, one of them placement-rejected =
    // three agents actually requested, so the batch must be admitted rather
    // than rejected wholesale as a cap breach.
    const { ops } = makeOps();
    const out = await ops.spawn(
      [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }, { prompt: "d", placement: "elsewhere" }],
      { parentAgentId: null, depth: 0 },
    );
    expect(out.filter((o) => o.ok)).toHaveLength(3);
    expect(out[3].ok).toBe(false);
    expect(registry.list()).toHaveLength(3);
  });
});

describe("fleet spawn concurrency (C3)", () => {
  it("serializes check-then-mint so two concurrent spawns cannot jointly exceed maxConcurrent", async () => {
    const { ops } = makeOps({ caps: { maxPerSpawn: 5, maxConcurrent: 3, maxDepth: 1 } });
    const ctx = { parentAgentId: null, depth: 0 };

    const [r1, r2] = await Promise.allSettled([
      ops.spawn([{ prompt: "a1" }, { prompt: "a2" }], ctx),
      ops.spawn([{ prompt: "b1" }, { prompt: "b2" }], ctx),
    ]);

    // The invariant that actually matters: total principals minted across
    // BOTH concurrent calls never exceeds the cap.
    expect(registry.list().length).toBeLessThanOrEqual(3);

    // With the mutex, this resolves deterministically: batch A (called
    // first) mints 2 and fills liveCount to 2; batch B's check then sees
    // 2 + 2 = 4 > 3 and rejects outright — cap-first, so batch B mints
    // NOTHING (not a partial 1-of-2 admission).
    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejected = [r1, r2].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect((rejected?.reason as Error).message).toMatch(/limit 3 concurrent/);
  });
});

describe("fleet dispatch failure recording (C1 + C2 + fix round 2 R1/R4)", () => {
  it(
    "R1 CRITICAL regression guard: a post-dispatch send() onEvent error must NOT stop or mark-stop the agent",
    async () => {
      // This is mngr's OWN "delivered but not yet answered" report — fired
      // on a perfectly healthy, still-working agent (a routine 300s
      // reply-timeout on a multi-step turn, or a single failed pre-send
      // transcript read). Fix round 1 treated ANY such event as fatal,
      // which stopped and permanently retired every long-running task —
      // this test guards against reintroducing that.
      const stopped: string[] = [];
      const backend = fakeBackend([]);
      const failing: AgentBackend = {
        ...backend,
        async send(ref, _prompt, onEvent) {
          onEvent({ type: "error", message: "mngr: message delivered but not yet answered" });
          return ref;
        },
        async stop(ref) {
          stopped.push(ref.agentId);
        },
      };
      const { ops } = makeOps({ backend: failing });
      const out = await ops.spawn([{ prompt: "x" }], { parentAgentId: null, depth: 0 });
      // M8: expectation read from the registry, not from `out` (see the I2
      // dispatch-only test above for why the self-referential form asserted
      // almost nothing).
      expect(out).toEqual([{ ok: true, agentId: registry.list()[0].agentId }]);
      const id = (out[0] as { ok: true; agentId: string }).agentId;

      await flushMicrotasks();

      expect(stopped).toEqual([]); // backend.stop must NEVER be called for this
      expect(registry.get(id)?.status).toBe("active"); // left ACTIVE, harvestable by check()/collect()
    },
  );

  it(
    "a REJECTING send() promise (defensive path, previously untested) also leaves the agent ACTIVE and untouched",
    async () => {
      const stopped: string[] = [];
      const backend = fakeBackend([]);
      const failing: AgentBackend = {
        ...backend,
        async send() {
          // A genuine promise rejection (as opposed to R4's synchronous
          // throw below) — the real backend never does this, but the
          // AgentBackend type doesn't forbid it, and R1's rule applies
          // regardless of which post-dispatch failure shape occurs.
          throw new Error("send() rejected");
        },
        async stop(ref) {
          stopped.push(ref.agentId);
        },
      };
      const { ops } = makeOps({ backend: failing });
      const out = await ops.spawn([{ prompt: "x" }], { parentAgentId: null, depth: 0 });
      const id = (out[0] as { ok: true; agentId: string }).agentId;

      await flushMicrotasks();

      expect(stopped).toEqual([]);
      expect(registry.get(id)?.status).toBe("active");
    },
  );

  it(
    "R4: a SYNCHRONOUS throw from send() (contract violation — dispatch never actually starts) " +
      "stops that one agent, reports ok:false for THAT task only, and does not sink the rest of the batch",
    async () => {
      const stopped: string[] = [];
      const backend = fakeBackend([]);
      const failing: AgentBackend = {
        ...backend,
        // Deliberately NOT `async` — a genuine SYNCHRONOUS throw, not a
        // rejected promise, simulating a backend that violates the
        // AgentBackend contract (send() must always return a Promise, even
        // on internal failure).
        send(ref, prompt) {
          if (prompt === "boom") throw new Error("sync send failure");
          return backend.send(ref, prompt, () => {});
        },
        async stop(ref) {
          stopped.push(ref.agentId);
        },
      };
      const { ops } = makeOps({ backend: failing });
      const out = await ops.spawn([{ prompt: "ok" }, { prompt: "boom" }], { parentAgentId: null, depth: 0 });
      // The whole batch survives — spawn() itself does NOT reject, unlike
      // pre-round-2 behaviour where this would sink Promise.all entirely.
      expect(out).toHaveLength(2);
      const okOutcome = out.find((o) => o.ok);
      const failedOutcome = out.find((o) => !o.ok) as { ok: false; error: string };
      expect(okOutcome).toBeDefined();
      expect(failedOutcome.error).toMatch(/sync send failure/);

      // Pre-dispatch abandonment (dispatch never reached mngr at all): this
      // IS still stop-then-markStopped via failAfterEnsure, unlike R1's
      // post-dispatch rule.
      const failedRecord = registry.list().find((r) => r.status === "stopped");
      expect(failedRecord).toBeDefined();
      expect(stopped).toEqual([failedRecord?.agentId]);
    },
  );

  it("R4 + C2: if stop() ALSO fails on the synchronous-throw path, the record stays ACTIVE (discoverable)", async () => {
    const backend = fakeBackend([]);
    const failing: AgentBackend = {
      ...backend,
      send(): never {
        throw new Error("sync send failure");
      },
      async stop() {
        throw new Error("mngr: stop refused");
      },
    };
    const { ops } = makeOps({ backend: failing });
    const out = await ops.spawn([{ prompt: "x" }], { parentAgentId: null, depth: 0 });
    const failed = out[0] as { ok: false; error: string };
    expect(failed.error).toMatch(/sync send failure/);
    // NOT marked stopped: stays discoverable via list()/check() for manual cleanup.
    expect(registry.get("rhumb-1")?.status).toBe("active");
  });
});

describe("fleet liveCount reconciliation (I1 + fix round 2 R2)", () => {
  it("a bound agent positively confirmed done/stopped frees its concurrency slot (I1 present-entry branch)", async () => {
    // maxConcurrent: 1 — if a DONE agent kept consuming its slot forever
    // (the registry's own "active" status never flips on its own), this
    // second spawn could never succeed again. This branch of liveCount had
    // no test at all before fix round 2.
    const { ops } = makeOps({
      caps: { maxPerSpawn: 5, maxConcurrent: 1, maxDepth: 1 },
      liveness: async () => new Map([["agent-native-rhumb-1", { state: "DONE" }]]),
    });
    const first = await ops.spawn([{ prompt: "a" }], { parentAgentId: null, depth: 0 });
    expect(first[0]).toEqual({ ok: true, agentId: "rhumb-1" });

    const second = await ops.spawn([{ prompt: "b" }], { parentAgentId: null, depth: 0 });
    expect(second[0]).toEqual({ ok: true, agentId: "rhumb-2" });
  });

  it(
    "R2: a never-bound record ages out of liveCount after the dispatch window, instead of bricking the fleet permanently",
    async () => {
      const REGISTRY_NOW_MS = Date.parse("2026-08-04T00:00:00.000Z"); // matches the fixed registry clock in beforeEach
      let nowMs = REGISTRY_NOW_MS;
      const brokenBackend: AgentBackend = {
        ...fakeBackend([]),
        async ensure(agentId) {
          // Always fails to bind — no real agent is EVER created for this
          // principal, simulating a permanently-broken spawn attempt.
          return { agentId, nativeId: null, backend: "mngr", reason: "create-failed" } as AgentRef;
        },
      };
      const { ops } = makeOps({
        backend: brokenBackend,
        caps: { maxPerSpawn: 5, maxConcurrent: 1, maxDepth: 1 },
        now: () => nowMs,
      });

      const first = await ops.spawn([{ prompt: "a" }], { parentAgentId: null, depth: 0 });
      expect(first[0]).toMatchObject({ ok: false });
      expect(registry.get("rhumb-1")).toMatchObject({ status: "active", nativeId: null });

      // Still within the dispatch window: the failed record keeps
      // consuming the only slot, so a second spawn correctly breaches
      // maxConcurrent (proves the window isn't simply always-excluded).
      await expect(
        ops.spawn([{ prompt: "b" }], { parentAgentId: null, depth: 0 }),
      ).rejects.toThrow(/limit 1 concurrent/);
      expect(registry.list()).toHaveLength(1); // the rejected attempt minted nothing

      // Advance past the window: the stale, never-bound record must stop
      // consuming the slot, or the fleet would be bricked forever after
      // just this one ensure failure — I1's own bug, reopened on the
      // failure path.
      nowMs += 11 * 60_000;
      const second = await ops.spawn([{ prompt: "c" }], { parentAgentId: null, depth: 0 });
      expect(second[0]).toMatchObject({ ok: false }); // still fails (broken backend) — but the CAP admitted the attempt
      expect(registry.list()).toHaveLength(2);
    },
  );

  it(
    "F1: a never-bound record with an unparseable/missing createdAt still COUNTS toward liveCount " +
      "(a legacy or hand-edited agents.json must not fail OPEN on the concurrency cap)",
    async () => {
      // Simulates a legacy/hand-edited index: agents.ts's on-load
      // normalisation covers parentAgentId/depth but not createdAt, so a
      // record like this is loadable as-is.
      const legacyIndexPath = join(dir, "legacy-agents.json");
      writeFileSync(
        legacyIndexPath,
        JSON.stringify([
          {
            agentId: "legacy-1",
            nativeId: null,
            backend: "mngr",
            name: "legacy",
            createdAt: "not-a-date", // Date.parse(...) => NaN
            lastActiveAt: "2026-08-04T00:00:00.000Z",
            status: "active",
            parentAgentId: null,
            depth: 0,
          },
        ]),
      );
      const legacyRegistry = createAgentRegistry({
        indexPath: legacyIndexPath,
        now: () => "2026-08-04T00:00:00.000Z",
        id: () => "rhumb-new",
      });
      const { ops } = makeOps({
        registry: legacyRegistry,
        caps: { maxPerSpawn: 5, maxConcurrent: 1, maxDepth: 1 },
      });

      // maxConcurrent: 1, and the legacy record alone should already
      // consume that one slot — a naive `age <= WINDOW` check would read
      // its age as NaN, silently exclude it, and let this spawn through.
      await expect(
        ops.spawn([{ prompt: "x" }], { parentAgentId: null, depth: 0 }),
      ).rejects.toThrow(/limit 1 concurrent/);
      expect(legacyRegistry.list()).toHaveLength(1); // nothing new minted
    },
  );
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

  it("reports a stopped principal's status as \"stopped\", never \"done\" (I3)", async () => {
    const { ops } = makeOps();
    const out = await ops.spawn([{ prompt: "x" }], { parentAgentId: null, depth: 0 });
    const id = (out[0] as { ok: true; agentId: string }).agentId;
    registry.markStopped(id);
    expect(await ops.check([id])).toEqual([{ agentId: id, status: "stopped" }]);
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

  it("collect returns the transcript's answer when the last assistant turn is TERMINAL", async () => {
    const backend = fakeBackend([]);
    const withTranscript: AgentBackend = {
      ...backend,
      async transcript() {
        return [{ kind: "text", text: "the real answer" }];
      },
    };
    const { ops } = makeOps({
      backend: withTranscript,
      liveness: async () => new Map([["agent-native-rhumb-1", { state: "DONE" }]]),
      lastFinishReason: async () => "end_turn",
    });
    const out = await ops.spawn([{ prompt: "x" }], { parentAgentId: null, depth: 0 });
    const id = (out[0] as { ok: true; agentId: string }).agentId;
    expect(await ops.collect([id])).toEqual([{ agentId: id, status: "done", result: "the real answer" }]);
  });

  it("collect WITHHOLDS the result when the last assistant message is NON-terminal narration (I4)", async () => {
    const backend = fakeBackend([]);
    const withTranscript: AgentBackend = {
      ...backend,
      async transcript() {
        return [{ kind: "text", text: "narrating a tool call I am about to make..." }];
      },
    };
    const { ops } = makeOps({
      backend: withTranscript,
      liveness: async () => new Map([["agent-native-rhumb-1", { state: "DONE" }]]),
      lastFinishReason: async () => "tool_use", // NON-terminal
    });
    const out = await ops.spawn([{ prompt: "x" }], { parentAgentId: null, depth: 0 });
    const id = (out[0] as { ok: true; agentId: string }).agentId;
    // mngr's own state says DONE (deriveAgentStatus's DONE branch doesn't
    // consult finish_reason), so status is "done" — but the narration must
    // not be handed back as the answer.
    expect(await ops.collect([id])).toEqual([{ agentId: id, status: "done", result: null }]);
  });

  it("collect reports EMPTY_COMPLETION_RESULT, not null, for a genuinely empty terminal completion (I5)", async () => {
    const backend = fakeBackend([]);
    const withTranscript: AgentBackend = {
      ...backend,
      async transcript() {
        return [{ kind: "text", text: "" }];
      },
    };
    const { ops } = makeOps({
      backend: withTranscript,
      liveness: async () => new Map([["agent-native-rhumb-1", { state: "DONE" }]]),
      lastFinishReason: async () => "end_turn",
    });
    const out = await ops.spawn([{ prompt: "x" }], { parentAgentId: null, depth: 0 });
    const id = (out[0] as { ok: true; agentId: string }).agentId;
    expect(await ops.collect([id])).toEqual([{ agentId: id, status: "done", result: EMPTY_COMPLETION_RESULT }]);
  });

  it(
    "final review, I5: a depth-0 (OPERATOR) principal is not readable through check/collect, " +
      "even when it is bound, active, and has a collectable transcript",
    async () => {
      // The registry is shared with the RHUMB_AGENT_BACKEND=mngr foreground
      // path (one instance per process over one agents.json), so it also
      // holds the operator's OWN conversation principals at depth 0.
      // check/collect are ungated and take model-supplied ids, so without an
      // ownership assertion the model could name one of those and read its
      // transcript's final answer — a cross-conversation read. Inert only
      // while liveness is stubbed; closed here, before it becomes live.
      const backend = fakeBackend([]);
      const withTranscript: AgentBackend = {
        ...backend,
        async transcript() {
          return [{ kind: "text", text: "the operator's own private answer" }];
        },
      };
      const { ops } = makeOps({
        backend: withTranscript,
        // Everything below is arranged so that ONLY the depth check can be
        // what refuses: the record is bound, mngr says DONE, and the finish
        // reason is terminal — i.e. this exact record WOULD collect if it
        // were a fleet child.
        liveness: async () => new Map([["agent-native-rhumb-1", { state: "DONE" }]]),
        lastFinishReason: async () => "end_turn",
      });

      // An operator-conversation principal: created directly (depth 0), not
      // through ops.spawn (which always stamps depth >= 1).
      const operatorRec = registry.create("operator-session", "mngr", { parentAgentId: null, depth: 0 });
      registry.bind(operatorRec.agentId, `agent-native-${operatorRec.agentId}`);
      expect(operatorRec.depth).toBe(0);

      // Same shape an entirely unknown id gets — deliberately not a
      // distinguishable "not yours", so the tools are not an existence
      // oracle for ids.
      expect(await ops.check([operatorRec.agentId])).toEqual([
        { agentId: operatorRec.agentId, status: "unknown" },
      ]);
      expect(await ops.collect([operatorRec.agentId])).toEqual([
        { agentId: operatorRec.agentId, status: "unknown", result: null },
      ]);
      expect(await ops.check(["no-such-agent"])).toEqual([{ agentId: "no-such-agent", status: "unknown" }]);
    },
  );

  it(
    "I5: the depth check precedes the stopped check — a STOPPED depth-0 principal still reads as unknown",
    async () => {
      // statusFor's `rec.status === "stopped"` branch comes before the
      // liveness lookup, so an ownership check placed after it would still
      // report on an operator principal.
      const { ops } = makeOps();
      const operatorRec = registry.create("operator-session", "mngr", { parentAgentId: null, depth: 0 });
      registry.markStopped(operatorRec.agentId);
      expect(await ops.check([operatorRec.agentId])).toEqual([
        { agentId: operatorRec.agentId, status: "unknown" },
      ]);
    },
  );

  it(
    "R5: collect WITHHOLDS the result (never EMPTY_COMPLETION_RESULT) when there are NO text entries " +
      "at all AND the finish reason is non-terminal",
    async () => {
      const backend = fakeBackend([]);
      const withTranscript: AgentBackend = {
        ...backend,
        async transcript() {
          return []; // no text entries whatsoever
        },
      };
      const { ops } = makeOps({
        backend: withTranscript,
        liveness: async () => new Map([["agent-native-rhumb-1", { state: "DONE" }]]),
        lastFinishReason: async () => "tool_use", // NON-terminal
      });
      const out = await ops.spawn([{ prompt: "x" }], { parentAgentId: null, depth: 0 });
      const id = (out[0] as { ok: true; agentId: string }).agentId;
      // Before R5's reorder, the empty-transcript check ran BEFORE the
      // terminality gate, so this reported EMPTY_COMPLETION_RESULT — a
      // confirmed-empty final answer — for a turn that in fact hasn't
      // terminated yet.
      expect(await ops.collect([id])).toEqual([{ agentId: id, status: "done", result: null }]);
    },
  );
});
