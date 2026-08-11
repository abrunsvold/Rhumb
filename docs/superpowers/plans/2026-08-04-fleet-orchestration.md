# Fleet Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the model allocate agents — expose `spawn`/`check`/`collect` as gated MCP tools so Opus decides whether a job wants one agent or twelve, backed by mngr, with caps and lineage enforced in Rhumb.

**Architecture:** P0 first makes agent completion detectable (`finish_reason` gating, empty-vs-silent, an `AgentStatus` derived from mngr's own liveness signals). P1 then adds a `fleet` MCP server that always spawns through the mngr backend regardless of the parent conversation's backend, so a fast `sdk` foreground turn can dispatch a background mngr fleet. `spawn` takes a task *list* so one operator approval covers a whole batch.

**Tech Stack:** TypeScript (ESM, `"type": "module"`, `.js` import specifiers), Node ≥20, vitest 2, express 4, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`/`tool`), mngr CLI 0.2.17.

**Spec:** `docs/superpowers/specs/2026-08-04-fleet-orchestration-design.md`

## Global Constraints

- **The `sdk` backend's behaviour must not change.** `agent-host/test/sessionManager.test.ts` and `agent-host/test/server.test.ts` must pass with **zero edits** — they are the regression guard. No existing test case anywhere may be weakened or deleted.
- **Do not modify** `src/infra/`, `src/ontology/`, `src/services/`, `client/`, or `dashboard-host/`. (`src/infra/server.ts` is *read* for the `canUseTool` pattern, never edited.)
- **All imports use `.js` specifiers** even though sources are `.ts` (ESM project).
- **No unit test may shell out** to a real `mngr`, `tmux`, `bash`, or the network. All mngr interaction goes through the existing injected `ExecFn` seam.
- **`agent-host/tsconfig.json` has `include: ["src"]`**, so `npm run build` does NOT typecheck `test/`. A clean build is not evidence a test file typechecks — rely on the vitest run.
- **Caps are enforced in the tool handler before any `mngr create` runs.** Never rely on prompt instructions to bound behaviour.
- **Cap defaults** (each overridable, validated at load): `RHUMB_FLEET_MAX_PER_SPAWN=8`, `RHUMB_FLEET_MAX_CONCURRENT=8`, `RHUMB_FLEET_MAX_DEPTH=1`.
- **An unrecognised `finish_reason` is NON-terminal** — keep waiting. Failing open here reintroduces the exact bug P0 exists to fix.
- **Every safety test must be shown to fail when its guard is removed.** For caps, gating, and lineage, the task says so explicitly; demonstrate the red state, don't just assert green.
- Run tests from `agent-host/`. Full: `npm test`. Single file: `npx vitest run test/<name>.test.ts`. Typecheck: `npm run build`.
- Commit after every task, Conventional Commits, matching existing history.

## File structure

| File | Responsibility |
| --- | --- |
| `src/backends/mngr.ts` (modify) | P0: parse `finish_reason`, gate the reply wait on a terminal reason, distinguish empty-but-complete |
| `src/fleet/status.ts` (create) | Derive `AgentStatus` from mngr list fields + terminal reason |
| `src/agents.ts` (modify) | Add `parentAgentId` / `depth` to `AgentRecord` |
| `src/fleet/caps.ts` (create) | Cap config, load-time validation, enforcement decisions |
| `src/fleet/ops.ts` (create) | `spawn`/`check`/`collect` core, backend- and transport-agnostic |
| `src/fleet/server.ts` (create) | `createSdkMcpServer` wrapper exposing the three tools |
| `src/config.ts` (modify) | Parse and validate the three cap vars |
| `src/index.ts` (modify) | Construct the fleet server, register it, gate `spawn`, audit spawns |

---

### Task 1: P0 — `finish_reason` plumbing and terminal-reason gating

**Files:**
- Modify: `agent-host/src/backends/mngr.ts`
- Test: `agent-host/test/backend-mngr.test.ts` (append)

**Interfaces:**
- Consumes: `TranscriptMessage` from `src/types.js`.
- Produces:
  - `interface TranscriptEntry extends TranscriptMessage { finishReason: string | null }`
  - `TERMINAL_FINISH_REASONS: ReadonlySet<string>`
  - `isTerminalFinishReason(reason: string | null): boolean`
  - `newAssistantReply(before, after)` now takes/returns `TranscriptEntry` and returns only terminal entries.

- [ ] **Step 1: Write the failing tests**

Append to `agent-host/test/backend-mngr.test.ts`:

```ts
import { isTerminalFinishReason, TERMINAL_FINISH_REASONS } from "../src/backends/mngr.js";

describe("terminal finish_reason", () => {
  it("treats stop_sequence and end_turn as terminal", () => {
    expect(isTerminalFinishReason("stop_sequence")).toBe(true);
    expect(isTerminalFinishReason("end_turn")).toBe(true);
    expect(TERMINAL_FINISH_REASONS.has("stop_sequence")).toBe(true);
  });

  it("treats null and UNRECOGNISED reasons as NON-terminal (fail closed)", () => {
    expect(isTerminalFinishReason(null)).toBe(false);
    expect(isTerminalFinishReason("tool_use")).toBe(false);
    expect(isTerminalFinishReason("some_future_reason")).toBe(false);
  });
});

describe("send() waits for a TERMINAL assistant message", () => {
  // Narration (no finish_reason) then the real answer (stop_sequence).
  // Pre-P0 this returned the narration.
  it("returns the terminal answer, not an earlier non-terminal segment", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");

    let transcriptCalls = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv.includes("transcript")) {
          transcriptCalls++;
          // 1st read = pre-send baseline (empty).
          if (transcriptCalls === 1) return { code: 0, stdout: "", stderr: "" };
          // 2nd read = narration only, NOT terminal.
          if (transcriptCalls === 2) {
            return {
              code: 0,
              stdout: JSON.stringify({ type: "assistant_message", text: "Let me look...", finish_reason: "tool_use" }),
              stderr: "",
            };
          }
          // 3rd read = narration + the real terminal answer.
          return {
            code: 0,
            stdout: [
              JSON.stringify({ type: "assistant_message", text: "Let me look...", finish_reason: "tool_use" }),
              JSON.stringify({ type: "assistant_message", text: "The answer is 42.", finish_reason: "stop_sequence" }),
            ].join("\n"),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      replyPollIntervalMs: 1,
      replyTimeoutMs: 1000,
    });

    const events: AgentEvent[] = [];
    await backend.send({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" }, "q", (e) => events.push(e));

    const last = events.at(-1) as { type: string; result?: string };
    expect(last.type).toBe("result");
    expect(last.result).toBe("The answer is 42.");
    expect(last.result).not.toBe("Let me look...");
  });

  it("reports an empty terminal reply as complete-with-no-output, never a bare empty result", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");

    let n = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv.includes("transcript")) {
          n++;
          if (n === 1) return { code: 0, stdout: "", stderr: "" };
          return {
            code: 0,
            stdout: JSON.stringify({ type: "assistant_message", text: "", finish_reason: "stop_sequence" }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      replyPollIntervalMs: 1,
      replyTimeoutMs: 1000,
    });

    const events: AgentEvent[] = [];
    await backend.send({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" }, "q", (e) => events.push(e));

    const last = events.at(-1) as { type: string; result?: string };
    expect(last.type).toBe("result");
    // Must be self-describing, not "".
    expect(last.result).toMatch(/no output/i);
    expect(last.result).not.toBe("");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/backend-mngr.test.ts`
Expected: FAIL — `isTerminalFinishReason` is not exported.

- [ ] **Step 3: Implement**

In `agent-host/src/backends/mngr.ts`:

```ts
/** A parsed mngr transcript event. Extends the public TranscriptMessage with
 *  the terminal-ness signal Rhumb needs internally; `transcript()` strips it
 *  before returning, so the public shape (mirrored in client/) is unchanged. */
export interface TranscriptEntry extends TranscriptMessage {
  finishReason: string | null;
}

/** Reasons that mean "the model is done with this turn". `"stop_sequence"` is
 *  observed in docs/dogfood/2026-08-03-mngr-phase0.md; `"end_turn"` is expected
 *  but unverified, so both are accepted. Anything ELSE — including null and
 *  reasons we have never seen — is deliberately NON-terminal: treating an
 *  unknown reason as terminal would reintroduce the bug this exists to fix. */
export const TERMINAL_FINISH_REASONS: ReadonlySet<string> = new Set(["stop_sequence", "end_turn"]);

export function isTerminalFinishReason(reason: string | null): boolean {
  return reason !== null && TERMINAL_FINISH_REASONS.has(reason);
}

/** Emitted when a turn completes with a terminal reason but no text. Distinct
 *  from a real answer AND from a timeout — with a fleet, "finished with nothing
 *  to say" and "still working" must not look alike. */
export const EMPTY_COMPLETION_RESULT = "(agent completed with no output)";
```

Replace `parseTranscriptLine`'s body to return `TranscriptEntry`:

```ts
function parseTranscriptLine(line: string): TranscriptEntry | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const finishReason = typeof e.finish_reason === "string" ? e.finish_reason : null;
  if (e.type === "user_message") {
    return typeof e.content === "string" ? { kind: "user", text: e.content, finishReason } : null;
  }
  if (e.type === "assistant_message") {
    return typeof e.text === "string" ? { kind: "text", text: e.text, finishReason } : null;
  }
  return null;
}
```

Replace `newAssistantReply` so only a terminal entry counts:

```ts
function newAssistantReply(
  before: TranscriptEntry[] | null,
  after: TranscriptEntry[] | null,
): TranscriptEntry | null {
  if (!after || before === null) return null;
  for (let i = after.length - 1; i >= before.length; i--) {
    const entry = after[i];
    if (entry.kind === "text" && isTerminalFinishReason(entry.finishReason)) return entry;
  }
  return null;
}
```

Where the result event is emitted, substitute the empty-completion text:

```ts
const text = reply.text.trim().length > 0 ? reply.text : EMPTY_COMPLETION_RESULT;
onEvent({ type: "result", result: text, isError: false });
```

Update every `TranscriptMessage[]` annotation in this file (`fetchTranscript`, the poll loop, internal locals) to `TranscriptEntry[]`. In `transcript()`, strip the extra field before returning:

```ts
return entries.map(({ finishReason: _ignored, ...m }) => m);
```

Also add the two injectable timing deps to `createMngrBackend`'s options, defaulting to the existing constants:

```ts
replyPollIntervalMs?: number;
replyTimeoutMs?: number;
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/backend-mngr.test.ts`
Expected: PASS, including every pre-existing test in that file.

- [ ] **Step 5: Full suite and typecheck**

Run: `npm test && npm run build`
Expected: all pass. `sessionManager.test.ts` and `server.test.ts` unmodified.

- [ ] **Step 6: Commit**

```bash
git add agent-host/src/backends/mngr.ts agent-host/test/backend-mngr.test.ts
git commit -m "fix(agent-host): wait for a terminal finish_reason before returning a reply"
```

---

### Task 2: P0 — `AgentStatus` derivation

**Files:**
- Create: `agent-host/src/fleet/status.ts`
- Test: `agent-host/test/fleet-status.test.ts`

**Interfaces:**
- Consumes: `isTerminalFinishReason` from `../backends/mngr.js`.
- Produces:
  - `type AgentStatus = "working" | "done" | "failed" | "unknown"`
  - `interface MngrLiveness { state?: string; idleSeconds?: number }`
  - `deriveAgentStatus(deps: { liveness: MngrLiveness | null; lastAssistantFinishReason: string | null; idleThresholdSeconds?: number }): AgentStatus`

- [ ] **Step 1: Write the failing test**

Create `agent-host/test/fleet-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveAgentStatus } from "../src/fleet/status.js";

describe("deriveAgentStatus", () => {
  it("is done when a terminal reply exists and the agent has gone idle", () => {
    expect(deriveAgentStatus({
      liveness: { state: "WAITING", idleSeconds: 30 },
      lastAssistantFinishReason: "stop_sequence",
    })).toBe("done");
  });

  it("is working while the agent is active even with a terminal reply", () => {
    expect(deriveAgentStatus({
      liveness: { state: "RUNNING", idleSeconds: 0 },
      lastAssistantFinishReason: "stop_sequence",
    })).toBe("working");
  });

  it("is working when the last reply is non-terminal, however idle", () => {
    expect(deriveAgentStatus({
      liveness: { state: "WAITING", idleSeconds: 999 },
      lastAssistantFinishReason: "tool_use",
    })).toBe("working");
  });

  it("is failed when mngr reports a terminal-bad state", () => {
    expect(deriveAgentStatus({
      liveness: { state: "CRASHED", idleSeconds: 0 },
      lastAssistantFinishReason: null,
    })).toBe("failed");
    expect(deriveAgentStatus({
      liveness: { state: "FAILED", idleSeconds: 0 },
      lastAssistantFinishReason: "stop_sequence",
    })).toBe("failed");
  });

  it("is unknown when liveness cannot be read", () => {
    expect(deriveAgentStatus({ liveness: null, lastAssistantFinishReason: "stop_sequence" })).toBe("unknown");
  });

  it("respects a custom idle threshold", () => {
    expect(deriveAgentStatus({
      liveness: { state: "WAITING", idleSeconds: 3 },
      lastAssistantFinishReason: "stop_sequence",
      idleThresholdSeconds: 10,
    })).toBe("working");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/fleet-status.test.ts`
Expected: FAIL — cannot resolve `../src/fleet/status.js`.

- [ ] **Step 3: Implement**

Create `agent-host/src/fleet/status.ts`:

```ts
import { isTerminalFinishReason } from "../backends/mngr.js";

export type AgentStatus = "working" | "done" | "failed" | "unknown";

/** The subset of `mngr list --format json` fields Rhumb uses for liveness. */
export interface MngrLiveness {
  state?: string;
  idleSeconds?: number;
}

/** mngr states that mean the agent will never finish. */
const FAILED_STATES: ReadonlySet<string> = new Set(["CRASHED", "FAILED", "DESTROYED"]);

/** Seconds of idleness before an agent with a terminal reply counts as done.
 *  Guards against reading "done" during the gap between the model emitting a
 *  terminal message and starting its next tool call. */
const DEFAULT_IDLE_THRESHOLD_SECONDS = 5;

/** Status from BOTH mngr's own liveness signal and the transcript's terminal
 *  reason. Neither alone suffices: mngr knows the process is idle but not
 *  whether the model finished its thought; the transcript knows the reason but
 *  not whether the agent has since resumed. `null` liveness is "unknown", never
 *  "done" — the same unknowable-vs-absent discipline the backend uses. */
export function deriveAgentStatus(deps: {
  liveness: MngrLiveness | null;
  lastAssistantFinishReason: string | null;
  idleThresholdSeconds?: number;
}): AgentStatus {
  const { liveness, lastAssistantFinishReason } = deps;
  if (liveness === null) return "unknown";
  const state = (liveness.state ?? "").toUpperCase();
  if (FAILED_STATES.has(state)) return "failed";

  const threshold = deps.idleThresholdSeconds ?? DEFAULT_IDLE_THRESHOLD_SECONDS;
  const idle = liveness.idleSeconds ?? 0;
  if (!isTerminalFinishReason(lastAssistantFinishReason)) return "working";
  return idle >= threshold ? "done" : "working";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/fleet-status.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/fleet/status.ts agent-host/test/fleet-status.test.ts
git commit -m "feat(agent-host): derive AgentStatus from mngr liveness plus terminal finish_reason"
```

---

### Task 3: Registry lineage

**Files:**
- Modify: `agent-host/src/agents.ts`
- Test: `agent-host/test/agents.test.ts` (append)

**Interfaces:**
- Produces: `AgentRecord` gains `parentAgentId: string | null` and `depth: number`; `create(name, backend, lineage?)` accepts `{ parentAgentId, depth }`.

- [ ] **Step 1: Write the failing test**

Append to `agent-host/test/agents.test.ts`:

```ts
describe("lineage", () => {
  it("defaults to a root record with no parent at depth 0", () => {
    const rec = makeRegistry().create("solo", "mngr");
    expect(rec.parentAgentId).toBeNull();
    expect(rec.depth).toBe(0);
  });

  it("records an explicit parent and depth", () => {
    const reg = makeRegistry();
    const parent = reg.create("parent", "mngr");
    const child = reg.create("child", "mngr", { parentAgentId: parent.agentId, depth: 1 });
    expect(child.parentAgentId).toBe(parent.agentId);
    expect(child.depth).toBe(1);
  });

  it("persists lineage across instances", () => {
    const reg = makeRegistry();
    const parent = reg.create("parent", "mngr");
    const child = reg.create("child", "mngr", { parentAgentId: parent.agentId, depth: 1 });
    const reloaded = createAgentRegistry({ indexPath, now: () => "2026-08-04T00:00:00.000Z", id: () => "unused" });
    expect(reloaded.get(child.agentId)?.parentAgentId).toBe(parent.agentId);
    expect(reloaded.get(child.agentId)?.depth).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/agents.test.ts`
Expected: FAIL — `parentAgentId` undefined.

- [ ] **Step 3: Implement**

In `agent-host/src/agents.ts`, add to `AgentRecord`:

```ts
  /** The principal that spawned this one, or null for an operator-initiated
   *  root agent. Recorded, never inferred: the audit must be able to answer
   *  "spawned by whom" without reconstructing it. */
  parentAgentId: string | null;
  /** 0 for a root agent, parent.depth + 1 for a spawned one. Carried so the
   *  depth cap has a mechanism even where P1 cannot exceed it. */
  depth: number;
```

Change `create`'s signature in both the interface and the implementation:

```ts
create(name: string, backend: BackendId, lineage?: { parentAgentId: string | null; depth: number }): AgentRecord;
```

and in the implementation's record literal:

```ts
        parentAgentId: lineage?.parentAgentId ?? null,
        depth: lineage?.depth ?? 0,
```

Existing on-disk records lack both fields. `load()` already tolerates arbitrary JSON; normalise on read so older indexes stay usable:

```ts
    return Array.isArray(raw)
      ? (raw as AgentRecord[]).map((r) => ({
          ...r,
          parentAgentId: r.parentAgentId ?? null,
          depth: typeof r.depth === "number" ? r.depth : 0,
        }))
      : [];
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/agents.test.ts && npm test`
Expected: PASS. Every pre-existing `agents.test.ts` case still passes.

- [ ] **Step 5: Write the failing test for lineage as mngr labels**

The spec requires lineage to travel as mngr **labels** as well as registry fields — and specifically NOT via ambient environment, which the `RHUMB_*` wildcard blanking would silently erase. `ensureAgent` already calls `registry.get(agentId)`, and that record now carries the lineage, so `argvCreate` can emit the labels with no interface change.

Append to `agent-host/test/backend-mngr.test.ts`:

```ts
it("stamps lineage onto the mngr agent as labels, not as env", async () => {
  const calls: string[][] = [];
  const registry = makeRegistry();
  const parent = registry.create("parent", "mngr");
  const child = registry.create("child", "mngr", { parentAgentId: parent.agentId, depth: 1 });
  const backend = createMngrBackend({
    exec: async (argv) => {
      calls.push(argv);
      if (argv.includes("list")) {
        return { code: 0, stdout: JSON.stringify({ agents: [] }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    registry,
    credentialEnv: {},
    spec: CONFORMANCE_SPEC,
  });

  await backend.ensure(child.agentId, CONFORMANCE_SPEC);

  const create = calls.find((c) => c.includes("create")) ?? [];
  const labels = create.filter((_, i) => create[i - 1] === "--label");
  expect(labels).toContain(`rhumb_parent_id=${parent.agentId}`);
  expect(labels).toContain("rhumb_depth=1");
  // Lineage must NOT be smuggled through the environment, which the RHUMB_*
  // blanking would erase.
  const envArgs = create.filter((_, i) => create[i - 1] === "--env");
  expect(envArgs.some((e) => e.startsWith("RHUMB_PARENT_ID="))).toBe(false);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/backend-mngr.test.ts`
Expected: FAIL — no `rhumb_parent_id` label is emitted.

- [ ] **Step 7: Emit the lineage labels**

In `agent-host/src/backends/mngr.ts`, extend `argvCreate` to take the lineage and append the labels beside the existing `rhumb_agent_id` one:

```ts
const argvCreate = (
  name: string,
  agentId: string,
  credentialEnv: Record<string, string>,
  extraBlankedVars: readonly string[],
  lineage: { parentAgentId: string | null; depth: number },
): string[] => [
  "create", name, "claude", "--no-connect", "-y",
  "--label", `${RHUMB_AGENT_ID_LABEL}=${agentId}`,
  ...(lineage.parentAgentId ? ["--label", `rhumb_parent_id=${lineage.parentAgentId}`] : []),
  "--label", `rhumb_depth=${lineage.depth}`,
  ...credentialEnvFlags(credentialEnv, extraBlankedVars),
  // ...the existing --from / --transfer / --no-ensure-clean and `--` args block, unchanged
];
```

At the single call site in `ensureAgent`, pass the record's lineage (defaulting to root when the record is absent):

```ts
const lineage = { parentAgentId: existing?.parentAgentId ?? null, depth: existing?.depth ?? 0 };
```

Do not touch the `--env` block, the `--` agent-args block, or the ordering of anything already there.

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run test/backend-mngr.test.ts && npm test && npm run build`
Expected: PASS, including every pre-existing `backend-mngr.test.ts` case.

- [ ] **Step 9: Commit**

```bash
git add agent-host/src/agents.ts agent-host/src/backends/mngr.ts agent-host/test/agents.test.ts agent-host/test/backend-mngr.test.ts
git commit -m "feat(agent-host): record spawn lineage on principals and stamp it as mngr labels"
```

---

### Task 4: Cap configuration

**Files:**
- Create: `agent-host/src/fleet/caps.ts`
- Modify: `agent-host/src/config.ts`
- Test: `agent-host/test/fleet-caps.test.ts`
- Test: `agent-host/test/config.test.ts` (append)

**Interfaces:**
- Produces:
  - `interface FleetCaps { maxPerSpawn: number; maxConcurrent: number; maxDepth: number }`
  - `loadFleetCaps(env: NodeJS.ProcessEnv): FleetCaps`
  - `type CapBreach = { cap: "perSpawn" | "concurrent" | "depth"; limit: number; actual: number }`
  - `checkCaps(deps: { caps: FleetCaps; requested: number; liveCount: number; depth: number }): CapBreach | null`
  - `capBreachMessage(b: CapBreach): string`
  - `Config.fleetCaps: FleetCaps`

- [ ] **Step 1: Write the failing tests**

Create `agent-host/test/fleet-caps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadFleetCaps, checkCaps, capBreachMessage } from "../src/fleet/caps.js";

const CAPS = { maxPerSpawn: 8, maxConcurrent: 8, maxDepth: 1 };

describe("loadFleetCaps", () => {
  it("defaults to 8/8/1", () => {
    expect(loadFleetCaps({})).toEqual(CAPS);
  });

  it("reads overrides", () => {
    expect(loadFleetCaps({
      RHUMB_FLEET_MAX_PER_SPAWN: "3",
      RHUMB_FLEET_MAX_CONCURRENT: "4",
      RHUMB_FLEET_MAX_DEPTH: "2",
    })).toEqual({ maxPerSpawn: 3, maxConcurrent: 4, maxDepth: 2 });
  });

  it("rejects non-numeric and non-positive values at load", () => {
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_PER_SPAWN: "lots" })).toThrow(/RHUMB_FLEET_MAX_PER_SPAWN/);
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_CONCURRENT: "0" })).toThrow(/RHUMB_FLEET_MAX_CONCURRENT/);
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_DEPTH: "-1" })).toThrow(/RHUMB_FLEET_MAX_DEPTH/);
  });
});

describe("checkCaps — boundaries", () => {
  it("allows exactly the limit and rejects one more (perSpawn)", () => {
    expect(checkCaps({ caps: CAPS, requested: 8, liveCount: 0, depth: 0 })).toBeNull();
    expect(checkCaps({ caps: CAPS, requested: 9, liveCount: 0, depth: 0 }))
      .toEqual({ cap: "perSpawn", limit: 8, actual: 9 });
  });

  it("counts requested PLUS already-live against maxConcurrent", () => {
    expect(checkCaps({ caps: CAPS, requested: 3, liveCount: 5, depth: 0 })).toBeNull();
    expect(checkCaps({ caps: CAPS, requested: 4, liveCount: 5, depth: 0 }))
      .toEqual({ cap: "concurrent", limit: 8, actual: 9 });
  });

  it("rejects a spawn that would exceed maxDepth", () => {
    expect(checkCaps({ caps: CAPS, requested: 1, liveCount: 0, depth: 0 })).toBeNull();
    expect(checkCaps({ caps: CAPS, requested: 1, liveCount: 0, depth: 1 }))
      .toEqual({ cap: "depth", limit: 1, actual: 2 });
  });

  it("message names the cap and the numbers", () => {
    expect(capBreachMessage({ cap: "concurrent", limit: 8, actual: 9 }))
      .toMatch(/concurrent.*8.*9|9.*8/i);
  });
});
```

Append to `agent-host/test/config.test.ts` (its imports already exist):

```ts
describe("fleet caps in config", () => {
  const base = { CLAUDE_CODE_OAUTH_TOKEN: "tok", RHUMB_ALLOWED_USERS: "you@example.com" } as NodeJS.ProcessEnv;

  it("exposes defaults", () => {
    expect(loadConfig({ ...base }).fleetCaps).toEqual({ maxPerSpawn: 8, maxConcurrent: 8, maxDepth: 1 });
  });

  it("fails at load on a malformed cap", () => {
    expect(() => loadConfig({ ...base, RHUMB_FLEET_MAX_CONCURRENT: "nope" })).toThrow(/RHUMB_FLEET_MAX_CONCURRENT/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/fleet-caps.test.ts test/config.test.ts`
Expected: FAIL — cannot resolve `../src/fleet/caps.js`.

- [ ] **Step 3: Implement**

Create `agent-host/src/fleet/caps.ts`:

```ts
/** Hard bounds on model-directed spawning. Enforced in the tool handler BEFORE
 *  any `mngr create` runs, so a model that ignores its instructions still
 *  cannot exceed them. Never enforced by prompt. */
export interface FleetCaps {
  maxPerSpawn: number;
  maxConcurrent: number;
  maxDepth: number;
}

const DEFAULTS: FleetCaps = { maxPerSpawn: 8, maxConcurrent: 8, maxDepth: 1 };

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return n;
}

export function loadFleetCaps(env: NodeJS.ProcessEnv): FleetCaps {
  return {
    maxPerSpawn: positiveInt(env, "RHUMB_FLEET_MAX_PER_SPAWN", DEFAULTS.maxPerSpawn),
    maxConcurrent: positiveInt(env, "RHUMB_FLEET_MAX_CONCURRENT", DEFAULTS.maxConcurrent),
    maxDepth: positiveInt(env, "RHUMB_FLEET_MAX_DEPTH", DEFAULTS.maxDepth),
  };
}

export type CapBreach = {
  cap: "perSpawn" | "concurrent" | "depth";
  limit: number;
  actual: number;
};

/** Returns the FIRST breach, or null when the spawn is allowed. `depth` is the
 *  depth of the SPAWNING principal; children land at depth + 1. */
export function checkCaps(deps: {
  caps: FleetCaps;
  requested: number;
  liveCount: number;
  depth: number;
}): CapBreach | null {
  const { caps, requested, liveCount, depth } = deps;
  if (requested > caps.maxPerSpawn) {
    return { cap: "perSpawn", limit: caps.maxPerSpawn, actual: requested };
  }
  if (liveCount + requested > caps.maxConcurrent) {
    return { cap: "concurrent", limit: caps.maxConcurrent, actual: liveCount + requested };
  }
  if (depth + 1 > caps.maxDepth) {
    return { cap: "depth", limit: caps.maxDepth, actual: depth + 1 };
  }
  return null;
}

export function capBreachMessage(b: CapBreach): string {
  switch (b.cap) {
    case "perSpawn":
      return `fleet: ${b.actual} tasks requested, limit ${b.limit} per spawn`;
    case "concurrent":
      return `fleet: would bring ${b.actual} agents live, limit ${b.limit} concurrent`;
    case "depth":
      return `fleet: spawn would reach depth ${b.actual}, limit ${b.limit}`;
  }
}
```

In `agent-host/src/config.ts`, import and wire it:

```ts
import { loadFleetCaps, type FleetCaps } from "./fleet/caps.js";
```

Add `fleetCaps: FleetCaps;` to `interface Config`, and `fleetCaps: loadFleetCaps(env),` to the returned object.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/fleet-caps.test.ts test/config.test.ts && npm run build`
Expected: PASS, build clean.

- [ ] **Step 5: Prove the cap tests discriminate**

Temporarily change `checkCaps`'s concurrent branch to `if (false)`. Re-run:

Run: `npx vitest run test/fleet-caps.test.ts`
Expected: the "counts requested PLUS already-live" test FAILS. **Restore the line and confirm green again before committing.** Record in the report that you did this. A cap test that passes with the cap removed is worthless.

- [ ] **Step 6: Commit**

```bash
git add agent-host/src/fleet/caps.ts agent-host/src/config.ts agent-host/test/fleet-caps.test.ts agent-host/test/config.test.ts
git commit -m "feat(agent-host): fleet caps with load-time validation and boundary enforcement"
```

---

### Task 5: Fleet operations core

**Files:**
- Create: `agent-host/src/fleet/ops.ts`
- Test: `agent-host/test/fleet-ops.test.ts`

**Interfaces:**
- Consumes: `AgentBackend`/`AgentRef` from `../backends/types.js`; `AgentRegistry` from `../agents.js`; `FleetCaps`/`checkCaps`/`capBreachMessage` from `./caps.js`; `AgentStatus`/`deriveAgentStatus`/`MngrLiveness` from `./status.js`.
- Produces:
  - `interface FleetTask { prompt: string; placement?: string }`
  - `type SpawnOutcome = { ok: true; agentId: string } | { ok: false; error: string }`
  - `interface FleetOps { spawn(tasks, ctx): Promise<SpawnOutcome[]>; check(agentIds): Promise<Array<{agentId: string; status: AgentStatus}>>; collect(agentIds, waitMs?): Promise<Array<{agentId: string; status: AgentStatus; result: string | null}>> }`
  - `createFleetOps(deps): FleetOps`

- [ ] **Step 1: Write the failing test**

Create `agent-host/test/fleet-ops.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/fleet-ops.test.ts`
Expected: FAIL — cannot resolve `../src/fleet/ops.js`.

- [ ] **Step 3: Implement**

Create `agent-host/src/fleet/ops.ts`:

```ts
import type { AgentBackend, AgentSpec } from "../backends/types.js";
import type { AgentRegistry } from "../agents.js";
import { checkCaps, capBreachMessage, type FleetCaps } from "./caps.js";
import { deriveAgentStatus, type AgentStatus, type MngrLiveness } from "./status.js";

export interface FleetTask {
  prompt: string;
  /** mngr address suffix. Local-only in P1; the parameter exists so remote
   *  placement widens this without a signature change. */
  placement?: string;
}

export type SpawnOutcome = { ok: true; agentId: string } | { ok: false; error: string };

export interface SpawnContext {
  parentAgentId: string | null;
  depth: number;
}

export interface FleetOps {
  spawn(tasks: FleetTask[], ctx: SpawnContext): Promise<SpawnOutcome[]>;
  check(agentIds: string[]): Promise<Array<{ agentId: string; status: AgentStatus }>>;
  collect(
    agentIds: string[],
    waitMs?: number,
  ): Promise<Array<{ agentId: string; status: AgentStatus; result: string | null }>>;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;

export function createFleetOps(deps: {
  backend: AgentBackend;
  registry: AgentRegistry;
  caps: FleetCaps;
  spec: AgentSpec;
  mintName: () => string;
  /** nativeId -> liveness, from `mngr list --format json`. A null return means
   *  UNKNOWABLE, never "nothing is live". */
  liveness: () => Promise<Map<string, MngrLiveness> | null>;
  /** The last assistant finish_reason for one agent, or null if unreadable. */
  lastFinishReason: (nativeId: string) => Promise<string | null>;
  pollIntervalMs?: number;
}): FleetOps {
  const { backend, registry, caps, spec, mintName, liveness, lastFinishReason } = deps;
  const pollInterval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  async function liveCount(): Promise<number> {
    return registry.list().filter((r) => r.backend === "mngr" && r.status === "active").length;
  }

  async function statusFor(agentId: string): Promise<AgentStatus> {
    const rec = registry.get(agentId);
    if (!rec) return "unknown";
    if (rec.status === "stopped") return "done";
    if (!rec.nativeId) return "working";
    const live = await liveness();
    if (live === null) return "unknown";
    return deriveAgentStatus({
      liveness: live.get(rec.nativeId) ?? null,
      lastAssistantFinishReason: await lastFinishReason(rec.nativeId),
    });
  }

  return {
    async spawn(tasks, ctx) {
      // Caps first: a breach rejects the WHOLE batch before any principal is
      // minted or any agent created. Partial application of a rejected spawn
      // would leave orphans the operator never approved.
      const breach = checkCaps({
        caps,
        requested: tasks.length,
        liveCount: await liveCount(),
        depth: ctx.depth,
      });
      if (breach) throw new Error(capBreachMessage(breach));

      const outcomes: SpawnOutcome[] = [];
      for (const task of tasks) {
        const rec = registry.create(mintName(), "mngr", {
          parentAgentId: ctx.parentAgentId,
          depth: ctx.depth + 1,
        });
        try {
          const ref = await backend.ensure(rec.agentId, spec);
          await backend.send(ref, task.prompt, () => {});
          outcomes.push({ ok: true, agentId: rec.agentId });
        } catch (e) {
          registry.markStopped(rec.agentId);
          outcomes.push({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return outcomes;
    },

    async check(agentIds) {
      const out: Array<{ agentId: string; status: AgentStatus }> = [];
      for (const agentId of agentIds) out.push({ agentId, status: await statusFor(agentId) });
      return out;
    },

    async collect(agentIds, waitMs = 0) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const statuses = await Promise.all(agentIds.map(async (a) => ({ agentId: a, status: await statusFor(a) })));
        const settled = statuses.every((s) => s.status !== "working");
        if (settled || Date.now() >= deadline) {
          return Promise.all(
            statuses.map(async (s) => {
              const rec = registry.get(s.agentId);
              const msgs = rec?.nativeId ? await backend.transcript({ agentId: s.agentId, nativeId: rec.nativeId, backend: "mngr" }) : null;
              const last = msgs?.filter((m) => m.kind === "text").at(-1) ?? null;
              return { agentId: s.agentId, status: s.status, result: s.status === "done" ? (last?.text ?? null) : null };
            }),
          );
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
    },
  };
}
```

`registry.create`'s `lineage.parentAgentId` is typed `string | null` (Task 3), so `ctx.parentAgentId` passes through directly — a root spawn records `null`, a nested one records the parent's principal.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/fleet-ops.test.ts && npm run build`
Expected: PASS, build clean.

- [ ] **Step 5: Prove the cap-rejection test discriminates**

Temporarily delete the `if (breach) throw ...` line. Re-run:

Run: `npx vitest run test/fleet-ops.test.ts`
Expected: "REJECTS the whole batch… creating ZERO principals" FAILS. **Restore and confirm green.** Record it in the report.

- [ ] **Step 6: Commit**

```bash
git add agent-host/src/fleet/ops.ts agent-host/test/fleet-ops.test.ts
git commit -m "feat(agent-host): fleet spawn/check/collect core with cap-first rejection"
```

---

### Task 6: The `fleet` MCP server

**Files:**
- Create: `agent-host/src/fleet/server.ts`
- Test: `agent-host/test/fleet-server.test.ts`

**Interfaces:**
- Consumes: `FleetOps` from `./ops.js`.
- Produces: `createFleetServer(ops: FleetOps, ctx: () => SpawnContext)`; `FLEET_TOOL_NAMES: readonly string[]`; `GATED_FLEET_TOOL_NAMES: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing test**

Create `agent-host/test/fleet-server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FLEET_TOOL_NAMES, GATED_FLEET_TOOL_NAMES, createFleetServer } from "../src/fleet/server.js";

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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/fleet-server.test.ts`
Expected: FAIL — cannot resolve `../src/fleet/server.js`.

- [ ] **Step 3: Implement**

Create `agent-host/src/fleet/server.ts`, following `src/ontology/server.ts`'s shape:

```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FleetOps, SpawnContext } from "./ops.js";

export const FLEET_TOOL_NAMES = [
  "mcp__fleet__spawn",
  "mcp__fleet__check",
  "mcp__fleet__collect",
] as const;

/** Only `spawn` mutates anything or costs money, so only `spawn` is gated.
 *  `check`/`collect` are reads and must stay ungated — forcing an approval to
 *  poll would make the operator approve constantly and learn to click through. */
export const GATED_FLEET_TOOL_NAMES: ReadonlySet<string> = new Set(["mcp__fleet__spawn"]);

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

export function createFleetServer(ops: FleetOps, ctx: () => SpawnContext) {
  return createSdkMcpServer({
    name: "fleet",
    version: "1.0.0",
    tools: [
      tool(
        "spawn",
        "Spawn one background agent per task and return their Rhumb principal ids. " +
          "Returns IMMEDIATELY — the agents are still working when this returns. " +
          "Use check/collect to find out when they finish. Each agent runs in its own " +
          "process and cannot itself spawn. Requires operator approval.",
        {
          tasks: z
            .array(z.object({ prompt: z.string(), placement: z.string().optional() }))
            .describe("One entry per agent. Same prompt with different content = fan-out over a list; different prompts = a work queue."),
        },
        async (args) => {
          try {
            return ok(JSON.stringify(await ops.spawn(args.tasks, ctx())));
          } catch (e) {
            return ok(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        },
      ),
      tool(
        "check",
        "Status of previously spawned agents: working | done | failed | unknown. Cheap; safe to call repeatedly.",
        { agentIds: z.array(z.string()) },
        async (args) => ok(JSON.stringify(await ops.check(args.agentIds))),
      ),
      tool(
        "collect",
        "Results of previously spawned agents. Optionally waits up to waitMs for them to finish. " +
          "Returns PARTIAL results when the wait expires — agents still working come back with status 'working' and a null result, which is normal, not an error.",
        { agentIds: z.array(z.string()), waitMs: z.number().optional() },
        async (args) => ok(JSON.stringify(await ops.collect(args.agentIds, args.waitMs))),
      ),
    ],
  });
}
```

If `zod` is not already a dependency of `agent-host`, check how `src/infra/server.ts` declares its tool schemas and follow that exactly rather than adding a dependency.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/fleet-server.test.ts && npm run build`
Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/fleet/server.ts agent-host/test/fleet-server.test.ts
git commit -m "feat(agent-host): fleet MCP server exposing spawn/check/collect"
```

---

### Task 7: Wiring, gating, and audit

**Files:**
- Modify: `agent-host/src/index.ts`
- Test: `agent-host/test/fleet-wiring.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: no new exports; the fleet server is registered into `sessionExtraOptions.mcpServers` and `mcp__fleet__spawn` joins the gated set.

- [ ] **Step 1: Write the failing test**

Create `agent-host/test/fleet-wiring.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fleetGatedToolNames } from "../src/index.js";

describe("fleet gating wiring", () => {
  it("includes mcp__fleet__spawn in the gated tool set", () => {
    expect(fleetGatedToolNames()).toContain("mcp__fleet__spawn");
  });

  it("does not gate the read-only fleet tools", () => {
    expect(fleetGatedToolNames()).not.toContain("mcp__fleet__check");
    expect(fleetGatedToolNames()).not.toContain("mcp__fleet__collect");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/fleet-wiring.test.ts`
Expected: FAIL — `fleetGatedToolNames` is not exported.

- [ ] **Step 3: Implement**

In `agent-host/src/index.ts`, add imports beside the existing ones:

```ts
import { createFleetOps } from "./fleet/ops.js";
import { createFleetServer, FLEET_TOOL_NAMES, GATED_FLEET_TOOL_NAMES } from "./fleet/server.js";
import { createAgentRegistry as createFleetRegistry } from "./agents.js";
```

Export the small helper the test drives:

```ts
export function fleetGatedToolNames(): string[] {
  return [...GATED_FLEET_TOOL_NAMES];
}
```

Then, after the existing ontology-server registration and BEFORE the `SessionManager` construction, add the fleet block. It builds its own mngr backend and registry so fleet works even when `RHUMB_AGENT_BACKEND=sdk`:

```ts
  // The fleet ALWAYS spawns through mngr, whatever backend this conversation
  // uses — so a fast sdk foreground turn can dispatch a background mngr fleet.
  // mngr's prerequisites gate this block only, never the whole host.
  let fleetAvailable = false;
  try {
    assertMngrPrerequisites();
    fleetAvailable = true;
  } catch (e) {
    console.warn(`[rhumb] fleet tools unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (fleetAvailable) {
    const fleetRegistry = createFleetRegistry({
      indexPath: joinPath(deps.config.workspace, "agents.json"),
      now: () => new Date().toISOString(),
      id: () => `rhumb-${randomUUID()}`,
    });
    const fleetBackend = createMngrBackend({
      exec: createRealExec(),
      registry: fleetRegistry,
      credentialEnv: deps.config.provider.credentialEnv,
      spec: {
        model: deps.config.provider.model,
        workspace: deps.config.workspace,
        permissionMode: deps.config.permissionMode,
        extraOptions: {},
      },
      extraBlankedVars: Object.keys(process.env).filter((k) => k.startsWith("RHUMB_")),
    });
    const fleetOps = createFleetOps({
      backend: fleetBackend,
      registry: fleetRegistry,
      caps: deps.config.fleetCaps,
      spec: {
        model: deps.config.provider.model,
        workspace: deps.config.workspace,
        permissionMode: deps.config.permissionMode,
        extraOptions: {},
      },
      mintName: () => `fleet-${randomUUID().slice(0, 8)}`,
      liveness: async () => null,
      lastFinishReason: async () => null,
    });
    // Root conversation: no parent, depth 0. P2/P3 supply real lineage when a
    // spawned agent can itself reach these tools.
    const fleetServer = createFleetServer(fleetOps, () => ({ parentAgentId: null, depth: 0 }));
    sessionExtraOptions.mcpServers = { ...(sessionExtraOptions.mcpServers as object ?? {}), fleet: fleetServer };
    sessionExtraOptions.allowedTools = [
      ...((sessionExtraOptions.allowedTools as string[]) ?? []),
      ...FLEET_TOOL_NAMES.filter((n) => !GATED_FLEET_TOOL_NAMES.has(n)),
    ];
  }
```

`liveness` and `lastFinishReason` are wired to `null` stubs here deliberately: reading them requires `mngr list`/`mngr transcript` calls the fleet backend does not yet expose publicly. Task 8's live test drives the real path; keeping the stubs explicit (rather than fabricating a status) means `check` honestly reports `unknown` instead of guessing.

Where `makeCanUseTool` is constructed for infra, extend the gated set so `mcp__fleet__spawn` routes through the same approval path. Follow `src/infra/server.ts`'s `GATED_TOOL_NAMES` pattern exactly; do not duplicate the approval logic.

**Audit every spawn.** The spec requires the log to answer "which agent did this, spawned by whom, under whose authorization" without reconstruction. Reuse `appendInfraAudit` (already imported in this file) rather than inventing a second log. Wrap the ops passed to `createFleetServer` so a spawn records its outcome:

```ts
    const auditedOps = {
      ...fleetOps,
      async spawn(tasks: FleetTask[], ctx: SpawnContext) {
        const now = new Date().toISOString();
        try {
          const outcomes = await fleetOps.spawn(tasks, ctx);
          appendInfraAudit(infra.auditPath, {
            ts: now,
            tool: "mcp__fleet__spawn",
            // Prompts are the operator's own text, but they can be long; record
            // the shape and the resulting principals, not the full prompts.
            input: { taskCount: tasks.length, parentAgentId: ctx.parentAgentId, depth: ctx.depth },
            decision: "executed",
            result: {
              spawned: outcomes.filter((o) => o.ok).map((o) => (o as { agentId: string }).agentId),
              failed: outcomes.filter((o) => !o.ok).length,
            },
          });
          return outcomes;
        } catch (e) {
          appendInfraAudit(infra.auditPath, {
            ts: now,
            tool: "mcp__fleet__spawn",
            input: { taskCount: tasks.length, parentAgentId: ctx.parentAgentId, depth: ctx.depth },
            decision: "error",
            error: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }
      },
    };
```

Pass `auditedOps` to `createFleetServer`. Note `infra.auditPath` exists only when infra is configured; when it is not, skip the audit wrapper and use `fleetOps` directly rather than crashing — and say so in a comment, since an unaudited spawn on a non-infra box is a deliberate, documented gap rather than an oversight.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/fleet-wiring.test.ts && npm test && npm run build`
Expected: PASS. `sessionManager.test.ts` and `server.test.ts` unmodified.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/index.ts agent-host/test/fleet-wiring.test.ts
git commit -m "feat(agent-host): register the fleet MCP server and gate spawn"
```

---

### Task 8: Live two-agent fleet, and docs

**Files:**
- Create: `agent-host/test/fleet.integration.test.ts`
- Modify: `agent-host/README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: everything above. Produces no new exports.

- [ ] **Step 1: Write the live test**

Create `agent-host/test/fleet.integration.test.ts`, mirroring the gating style of `test/backend-mngr.integration.test.ts` (read it first — it shows the opt-in guard, the temp-workspace setup, and the cleanup helpers):

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";

const has = (bin: string) => spawnSync("command", ["-v", bin], { shell: true }).status === 0;
// Opt-in: this spawns REAL agents at ~90s each and is not part of `npm test`.
const live = process.env.RHUMB_LIVE_MNGR === "1" && has("mngr") && has("tmux");

describe.skipIf(!live)("fleet (live, localhost)", () => {
  let dir: string;
  let registry: AgentRegistry;
  const createdNames: string[] = [];

  beforeAll(() => {
    // A disposable git repo as the workspace: agents run IN PLACE there
    // (--transfer none), so never point this at the Rhumb checkout.
    dir = mkdtempSync(join(tmpdir(), "rhumb-fleet-live-"));
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), ".claude/\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
    registry = createAgentRegistry({
      indexPath: join(dir, "agents.json"),
      now: () => new Date().toISOString(),
      id: () => `rhumb-live-${randomUUID().slice(0, 8)}`,
    });
  });

  afterAll(() => {
    for (const name of createdNames) {
      spawnSync("mngr", ["destroy", name, "--force", "-b"], { stdio: "ignore" });
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawns two real agents, both settle, results collect", { timeout: 600_000 }, async () => {
    const spec = { model: "claude-opus-4-8", workspace: dir, permissionMode: "acceptEdits", extraOptions: {} };
    const backend = createMngrBackend({
      exec: createRealExec(),
      registry,
      credentialEnv: process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
        : {},
      spec,
    });
    const ops = createFleetOps({
      backend,
      registry,
      caps: { maxPerSpawn: 8, maxConcurrent: 8, maxDepth: 1 },
      spec,
      mintName: () => {
        const n = `fleet-live-${randomUUID().slice(0, 8)}`;
        createdNames.push(n);
        return n;
      },
      liveness: async () => null,
      lastFinishReason: async () => null,
      pollIntervalMs: 3000,
    });

    const outcomes = await ops.spawn(
      [{ prompt: "Reply with exactly the word: alpha" }, { prompt: "Reply with exactly the word: beta" }],
      { parentAgentId: null, depth: 0 },
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    const ids = outcomes.map((o) => (o as { ok: true; agentId: string }).agentId);
    expect(new Set(ids).size).toBe(2); // two DISTINCT principals

    // Each principal is bound to its own distinct mngr agent.
    const natives = ids.map((id) => registry.get(id)?.nativeId);
    expect(natives.every(Boolean)).toBe(true);
    expect(new Set(natives).size).toBe(2);

    // Lineage recorded for both.
    for (const id of ids) {
      expect(registry.get(id)?.depth).toBe(1);
    }

    const collected = await ops.collect(ids, 240_000);
    expect(collected).toHaveLength(2);
    for (const c of collected) {
      expect(["done", "working", "failed", "unknown"]).toContain(c.status);
    }
  });
});
```

Add the imports this needs at the top of the file: `mkdtempSync`, `rmSync`, `writeFileSync` from `node:fs`; `join` from `node:path`; `tmpdir` from `node:os`; `randomUUID` from `node:crypto`; `execFileSync`/`spawnSync` from `node:child_process`; plus `createMngrBackend`, `createRealExec`, `createAgentRegistry`, `type AgentRegistry`, and `createFleetOps`.

Note the status assertion is deliberately permissive: with `liveness` stubbed to `null` in P1 (see Task 7), `check` honestly reports `unknown`. What this test proves is the part that matters now — **two distinct principals, two distinct mngr agents, lineage recorded, and `collect` returning cleanly per agent**. Tighten it to `status === "done"` only once the real liveness wiring lands (see Follow-ups).

- [ ] **Step 2: Run the live test**

Run: `RHUMB_LIVE_MNGR=1 PATH="$HOME/.local/bin:$PATH" npx vitest run test/fleet.integration.test.ts`
Expected: PASS. Report the real output. Expect ~3-4 minutes: each `mngr create` plus turn costs ~90s, and the two run concurrently.

- [ ] **Step 3: Confirm it skips by default**

Run: `npm test`
Expected: fast (~2s), with the live file reported as skipped. If `npm test` got slow, the opt-in guard is wrong.

- [ ] **Step 4: Document**

In `.env.example`, beside the other `RHUMB_*` entries:

```bash
# Fleet: bounds on model-directed agent spawning. Enforced by the host, not by
# prompt. Defaults shown. Fleet tools require mngr/tmux/git/jq and bash >= 4;
# when they are missing the host logs a warning and omits the tools.
# RHUMB_FLEET_MAX_PER_SPAWN=8
# RHUMB_FLEET_MAX_CONCURRENT=8
# RHUMB_FLEET_MAX_DEPTH=1
```

In `agent-host/README.md`, add a "Fleet (experimental)" section stating: what the three tools do; that `spawn` returns immediately and requires operator approval, once per batch rather than per agent; the three caps with defaults and their variables; that spawned agents always run via mngr regardless of `RHUMB_AGENT_BACKEND`, so an `sdk` conversation can dispatch a background fleet; that a spawned agent **cannot itself spawn**, because mngr agents receive no in-process MCP servers; and that at ~90s per mngr turn the fleet is for background work, not interactive chat.

- [ ] **Step 5: Full suite and typecheck**

Run: `npm test && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add agent-host/test/fleet.integration.test.ts agent-host/README.md .env.example
git commit -m "test(agent-host): live two-agent fleet spawn; document fleet tools and caps"
```

---

## Done when

- `npm test` and `npm run build` pass, and `npm test` is still fast (live suites opt-in).
- `test/sessionManager.test.ts` and `test/server.test.ts` are unmodified in the diff.
- A tool-using transcript returns the terminal answer, never earlier narration.
- An empty terminal reply is self-describing, never `""`.
- Every cap rejects at its boundary, and each cap test has been shown to fail with its guard removed.
- A cap breach or denied approval creates **zero** principals.
- Lineage (`parentAgentId`, `depth`) is persisted for every spawned principal.
- The live test spawns two real agents, both settle, and results collect.

## Follow-ups (not this plan)

- P2 visibility: dashboard/client agent list, lineage tree, per-agent transcript, stop. Wires the currently caller-less `list`/`stop`/`transcript`.
- P3 multi-host: SSH/Docker/Modal placement, and the out-of-process trust gate it forces.
- Real `liveness`/`lastFinishReason` wiring (stubbed to `null` in Task 7) so `check` reports true status rather than `unknown`.
- Token/cost budgeting via mngr's `claude_usage` plugin.
- Slice 1's parked items: `sessions.json` polluted with mngr ids; the live suite's tight `waitForClaudePid` window; credential rotation not reaching live agents.
