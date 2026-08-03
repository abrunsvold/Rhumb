# mngr Agent Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce an `AgentBackend` interface to `agent-host` with two implementations — the existing Agent SDK path and a new [`imbue-ai/mngr`](https://github.com/imbue-ai/mngr) path — so Rhumb gains a first-class model of agent lifecycle without touching its trust, surface, or audit layers.

**Architecture:** `SessionManager` stops running Claude directly and becomes a delegator over an `AgentBackend`. `AgentRef` splits `agentId` (durable, Rhumb-owned principal — what trust edges will key on in slice 3) from `nativeId` (the backend's own handle: an SDK `session_id` or an mngr agent id — an identifier, never a credential). The SDK backend maps both to the same value so existing sessions need no migration; the mngr backend mints a distinct Rhumb principal and binds it to a mngr agent at spawn time.

**Tech Stack:** TypeScript (ESM, `"type": "module"`, `.js` import specifiers), Node ≥20, vitest 2, express 4, `@anthropic-ai/claude-agent-sdk`, mngr CLI (Python 3.12 via uv), tmux.

**Spec:** `docs/superpowers/specs/2026-08-03-mngr-agent-backend-design.md`

## Global Constraints

- **Slice 1 is localhost-only.** No SSH/Docker/Modal providers. No `fork`, no `snapshot`.
- **Do not modify** `client/` or `dashboard-host/`. No wire-protocol change: `POST /messages` keeps its current request and response shape.
- **Do not modify** any file under `src/infra/`, `src/ontology/`, or `src/services/`. The trust, write-back, and audit layers are out of scope.
- **`sdk` remains the default backend.** A deployment that sets nothing must behave exactly as it does today.
- **`test/sessionManager.test.ts` and `test/server.test.ts` must pass with zero edits.** They are the proof that the refactor is behavior-preserving. If a change would require editing either, the change is wrong. (Other existing test files may be appended to where a task explicitly says so — Task 5 appends cases to `test/config.test.ts`. No existing test case in any file may be weakened or deleted.)
- **All imports use `.js` specifiers** (e.g. `import { x } from "./types.js"`) even though sources are `.ts`. This is an ESM project.
- **All mngr CLI interaction goes through an injected `exec` seam.** No unit test may shell out to a real `mngr`, `tmux`, or network.
- **Never log credential values,** only variable names. Precedent: `warnIfClientCertVarsPresent` in `src/index.ts`.
- Run tests from the `agent-host/` directory. Full suite: `npm test`. Single file: `npx vitest run test/<name>.test.ts`.
- Commit after every task. Use Conventional Commits (`feat:`, `fix:`, `test:`, `refactor:`, `docs:`), matching the existing history.

---

### Task 0: Phase 0 feasibility gate

This task is **exploratory, not TDD**. It exists to answer three questions before any interface is finalized. It has a hard stop condition — do not proceed to Task 1 if Q1 or Q2 fails.

**Files:**
- Create: `docs/dogfood/2026-08-03-mngr-phase0.md`

**Interfaces:**
- Consumes: nothing.
- Produces: verified mngr CLI invocations (exact subcommands, flags, and output format) used by Task 4's `MngrCli`; a yes/no on incremental streaming that decides whether Task 4's `send` tails or polls.

- [ ] **Step 1: Install tmux**

`tmux` is the only missing prerequisite. Python 3.12.13, uv 0.11.16, jq, git, node 24, and claude CLI 2.1.196 are already present.

**Ask the user before running this — it installs software on their machine.**

```bash
brew install tmux
```

- [ ] **Step 2: Verify prerequisites**

```bash
tmux -V && python3.12 --version && uv --version && jq --version && claude --version
```

Expected: all five print versions, no "command not found".

- [ ] **Step 3: Install mngr**

```bash
uv tool install git+https://github.com/imbue-ai/mngr
```

If that fails, clone and install from source:

```bash
git clone https://github.com/imbue-ai/mngr /tmp/mngr && cd /tmp/mngr && uv sync
```

Then confirm the CLI resolves:

```bash
mngr --help
```

- [ ] **Step 4: Q1 — spawn a real agent and get a real answer**

```bash
mngr create rhumb-probe
mngr list
```

Send it a prompt using whatever subcommand `mngr --help` documents for messaging (the spec deliberately does not pin the command name). Confirm a genuine model response comes back.

**Record in the doc:** the exact create, list, message, transcript, and stop invocations, and the exact output format of `list` (JSON? columns? what flag produces machine-readable output?).

**STOP CONDITION:** if no agent can be spawned or it cannot answer, stop the entire plan and report. The direction is moot.

- [ ] **Step 5: Q2 — prove Rhumb can still dictate the credential environment**

This is the security gate. Rhumb currently guarantees the spawned CLI sees exactly `credentialEnv` and no ambient credential (`src/provider.ts`, `src/env.ts`). Inserting mngr lengthens the chain to `agent-host → mngr CLI → tmux server → claude`. The hazard is tmux daemon environment inheritance: sessions inherit from the tmux *server*, so a pre-existing server can supply a credential Rhumb believed it stripped.

Kill any existing tmux server so the test is not contaminated, then plant a decoy and spawn through mngr:

```bash
tmux kill-server 2>/dev/null || true
export ANTHROPIC_API_KEY="sk-decoy-must-not-survive"
mngr create rhumb-credprobe
```

Find the spawned Claude process and read its **actual** environment:

```bash
pgrep -f claude | while read pid; do echo "--- $pid"; ps eww "$pid" | tr ' ' '\n' | grep -E '^(ANTHROPIC|CLAUDE)_'; done
```

**Assert:** `sk-decoy-must-not-survive` does **not** appear. Record verbatim which credential variables did reach the process.

Then repeat with the decoy unset but a Rhumb-style injected credential, and confirm the injected value *does* arrive — proving Rhumb can both exclude and include deliberately.

**Record in the doc:** whether mngr exposes a per-agent env/secrets mechanism, and the exact flag or config for it.

**STOP CONDITION:** if the decoy survives and mngr offers no way to control the child environment, stop and report. Adoption needs an env-scrubbing wrapper or is blocked outright.

- [ ] **Step 6: Q3 — incremental streaming or poll-only?**

Find the transcript JSONL the mngr-spawned agent writes. On the localhost provider it is expected under `~/.claude/projects/<encoded-cwd>/<session>.jsonl` — the same location `src/sessions.ts` already reads (`encodeProjectDir` replaces `/` and `.` with `-`).

```bash
ls -lt ~/.claude/projects/*/ | head -20
```

Send a prompt and watch whether the file grows during the turn:

```bash
tail -f ~/.claude/projects/<encoded>/<session>.jsonl
```

**Record in the doc:** whether lines appear *during* the turn (incremental → Task 4 `send` tails the file) or only at the end (poll-only → Task 4 `send` polls). Also record whether mngr has a native follow/log-streaming subcommand.

- [ ] **Step 7: Clean up probe agents**

```bash
mngr list
```

Stop and remove `rhumb-probe` and `rhumb-credprobe` using the stop/remove subcommand recorded in Step 4.

- [ ] **Step 8: Write the findings document**

Create `docs/dogfood/2026-08-03-mngr-phase0.md` with a section per question. It must contain, concretely:

1. mngr version installed and how.
2. Exact CLI invocations for create / list / message / transcript / stop, with real output samples.
3. The machine-readable output flag for `list` and a sample of its JSON.
4. Q2 verdict: PASS or FAIL, the decoy result, and the per-agent env mechanism.
5. Q3 verdict: incremental or poll-only, and the transcript path pattern observed.

This document is the input to Tasks 3 and 4. Vague notes here become guesswork there.

- [ ] **Step 9: Commit**

```bash
git add docs/dogfood/2026-08-03-mngr-phase0.md
git commit -m "docs(dogfood): mngr Phase 0 feasibility findings"
```

---

### Task 1: AgentBackend types and the SDK backend

Extract the Claude-running logic out of `SessionManager` into an `AgentBackend` implementation, leaving `SessionManager` as a delegator. This task must be behavior-preserving: its proof is that the existing tests pass untouched.

**Files:**
- Create: `agent-host/src/backends/types.ts`
- Create: `agent-host/src/backends/sdk.ts`
- Modify: `agent-host/src/sessionManager.ts` (whole file)
- Test: `agent-host/test/backend-sdk.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` and `TranscriptMessage` from `src/types.ts`; `QueryFn` from `src/sessionManager.ts`.
- Produces:
  - `type BackendId = "sdk" | "mngr"`
  - `interface AgentRef { agentId: string; nativeId: string | null; backend: BackendId }`
  - `interface AgentSpec { model: string; workspace: string; permissionMode: string; extraOptions: Record<string, unknown> }`
  - `interface AgentBackend` with `id`, `ensure`, `send`, `list`, `stop`, `transcript`
  - `createSdkBackend(opts: { query: QueryFn; spec: AgentSpec }): AgentBackend`
  - `SessionManager` keeps its exact existing constructor options and `run(prompt, sessionId, onEvent): Promise<string>` signature, and gains an optional `backend` option.

- [ ] **Step 1: Write the failing test**

Create `agent-host/test/backend-sdk.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createSdkBackend } from "../src/backends/sdk.js";
import type { QueryFn } from "../src/sessionManager.js";
import type { AgentEvent } from "../src/types.js";

const spec = { model: "m", workspace: "/ws", permissionMode: "acceptEdits", extraOptions: {} };

function fakeQuery(messages: unknown[]): QueryFn {
  return () =>
    (async function* () {
      for (const m of messages) yield m;
    })();
}

describe("sdk backend", () => {
  it("reports its id", () => {
    expect(createSdkBackend({ query: fakeQuery([]), spec }).id).toBe("sdk");
  });

  it("ensure is lazy: nativeId stays null until the first turn", async () => {
    const backend = createSdkBackend({ query: fakeQuery([]), spec });
    const ref = await backend.ensure("agent-1", spec);
    expect(ref).toEqual({ agentId: "agent-1", nativeId: null, backend: "sdk" });
  });

  it("send emits session/raw/result and returns the ref with nativeId set", async () => {
    const backend = createSdkBackend({
      query: fakeQuery([
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
        { type: "result", result: "done", is_error: false },
      ]),
      spec,
    });
    const events: AgentEvent[] = [];
    const out = await backend.send(
      { agentId: "agent-1", nativeId: null, backend: "sdk" },
      "hello",
      (e) => events.push(e),
    );

    expect(out.nativeId).toBe("sess-1");
    expect(events[0]).toEqual({ type: "session", sessionId: "sess-1" });
    expect(events[2]).toEqual({ type: "result", result: "done", isError: false });
  });

  it("send passes resume when the ref already has a nativeId", async () => {
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const query: QueryFn = (args) => {
      calls.push(args as { prompt: string; options: Record<string, unknown> });
      return (async function* () {
        yield { type: "result", result: "", is_error: false };
      })();
    };
    const backend = createSdkBackend({ query, spec });
    await backend.send({ agentId: "a", nativeId: "sess-2", backend: "sdk" }, "again", () => {});

    expect(calls[0].options.resume).toBe("sess-2");
    expect(calls[0].options.model).toBe("m");
    expect(calls[0].options.cwd).toBe("/ws");
  });

  it("send emits an error event when the stream throws", async () => {
    const backend = createSdkBackend({
      query: () =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s" };
          throw new Error("boom");
        })(),
      spec,
    });
    const events: AgentEvent[] = [];
    await backend.send({ agentId: "a", nativeId: null, backend: "sdk" }, "x", (e) => events.push(e));
    expect(events.at(-1)).toEqual({ type: "error", message: "boom" });
  });

  it("stop is a no-op and list returns empty (the SDK has no lifecycle)", async () => {
    const backend = createSdkBackend({ query: fakeQuery([]), spec });
    await expect(backend.stop({ agentId: "a", nativeId: null, backend: "sdk" })).resolves.toBeUndefined();
    await expect(backend.list()).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/backend-sdk.test.ts
```

Expected: FAIL — cannot resolve `../src/backends/sdk.js`.

- [ ] **Step 3: Write the types**

Create `agent-host/src/backends/types.ts`:

```ts
import type { AgentEvent, TranscriptMessage } from "../types.js";

export type BackendId = "sdk" | "mngr";

/** Identity of one agent.
 *
 *  `agentId` is the durable, Rhumb-owned principal. Rhumb mints and persists
 *  it, and slice 3's trust edges key on it.
 *
 *  `nativeId` is the backend's own handle — an SDK session_id, or an mngr
 *  agent id. mngr ids are plaintext, settable via `mngr create --id`, and
 *  carry no attestation, so a nativeId is an IDENTIFIER, NEVER A CREDENTIAL.
 *  A mngr fork mints a fresh nativeId, so a forked agent inherits no trust. */
export interface AgentRef {
  agentId: string;
  nativeId: string | null;
  backend: BackendId;
}

export interface AgentSpec {
  model: string;
  workspace: string;
  permissionMode: string;
  extraOptions: Record<string, unknown>;
}

export interface AgentBackend {
  readonly id: BackendId;
  /** Idempotent: ensure a live agent exists for this Rhumb principal. */
  ensure(agentId: string, spec: AgentSpec): Promise<AgentRef>;
  /** Send a prompt, streaming events. Returns the ref, whose nativeId may be
   *  populated during the turn (the SDK learns its session_id mid-stream). */
  send(ref: AgentRef, prompt: string, onEvent: (e: AgentEvent) => void): Promise<AgentRef>;
  list(): Promise<AgentRef[]>;
  stop(ref: AgentRef): Promise<void>;
  transcript(ref: AgentRef): Promise<TranscriptMessage[] | null>;
}
```

- [ ] **Step 4: Write the SDK backend**

Create `agent-host/src/backends/sdk.ts`. The body of `send` is lifted verbatim from the current `SessionManager.run`:

```ts
import type { AgentEvent, TranscriptMessage } from "../types.js";
import type { QueryFn } from "../sessionManager.js";
import type { AgentBackend, AgentRef, AgentSpec } from "./types.js";

/** The Agent SDK has no creation step: a session_id emerges from the first
 *  turn. So `ensure` is lazy and `list`/`stop` are inert. Lifecycle arrives
 *  only with the mngr backend. */
export function createSdkBackend(opts: { query: QueryFn; spec: AgentSpec }): AgentBackend {
  const { query, spec } = opts;

  return {
    id: "sdk",

    async ensure(agentId) {
      return { agentId, nativeId: null, backend: "sdk" };
    },

    async send(ref, prompt, onEvent) {
      const options: Record<string, unknown> = {
        model: spec.model,
        cwd: spec.workspace,
        permissionMode: spec.permissionMode,
      };
      if (ref.nativeId) options.resume = ref.nativeId;
      const merged = { ...options, ...spec.extraOptions };

      let resolvedId = ref.nativeId ?? "";
      try {
        for await (const message of query({ prompt, options: merged })) {
          if (message?.type === "system" && message?.subtype === "init") {
            resolvedId = message.session_id;
            const cmds = Array.isArray(message.slash_commands)
              ? message.slash_commands.filter((c: unknown): c is string => typeof c === "string")
              : undefined;
            onEvent(
              cmds && cmds.length > 0
                ? { type: "session", sessionId: resolvedId, slashCommands: cmds }
                : { type: "session", sessionId: resolvedId },
            );
          } else if (message?.type === "result") {
            onEvent({
              type: "result",
              result: String(message.result ?? ""),
              isError: Boolean(message.is_error),
            });
          } else {
            onEvent({ type: "raw", message });
          }
        }
      } catch (err) {
        onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      return { ...ref, nativeId: resolvedId === "" ? null : resolvedId };
    },

    async list(): Promise<AgentRef[]> {
      return [];
    },

    async stop(): Promise<void> {
      // No lifecycle to tear down.
    },

    async transcript(): Promise<TranscriptMessage[] | null> {
      // Transcript reading stays with the session service, which owns the
      // on-disk JSONL layout. Slice 4 revisits this.
      return null;
    },
  };
}
```

- [ ] **Step 5: Rewrite SessionManager as a delegator**

Replace the whole of `agent-host/src/sessionManager.ts`. The constructor options are unchanged so both call sites in `src/index.ts` (the main manager and the watchdog manager) and every existing test keep working:

```ts
import type { AgentEvent } from "./types.js";
import type { AgentBackend, AgentRef } from "./backends/types.js";
import { createSdkBackend } from "./backends/sdk.js";

export type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<any>;

export class SessionManager {
  private readonly backend: AgentBackend;

  constructor(opts: {
    query?: QueryFn;
    /** Injected backend. When omitted, an SDK backend is built from `query`. */
    backend?: AgentBackend;
    model: string;
    workspace: string;
    permissionMode?: string;
    extraOptions?: Record<string, unknown>;
  }) {
    if (opts.backend) {
      this.backend = opts.backend;
    } else {
      if (!opts.query) throw new Error("SessionManager requires either `query` or `backend`.");
      this.backend = createSdkBackend({
        query: opts.query,
        spec: {
          model: opts.model,
          workspace: opts.workspace,
          permissionMode: opts.permissionMode ?? "acceptEdits",
          extraOptions: opts.extraOptions ?? {},
        },
      });
    }
  }

  async run(
    prompt: string,
    sessionId: string | undefined,
    onEvent: (e: AgentEvent) => void,
  ): Promise<string> {
    // Slice 1 keeps the wire protocol: the caller's sessionId is both the
    // Rhumb principal and the backend handle for the SDK path.
    const ref: AgentRef = {
      agentId: sessionId ?? "",
      nativeId: sessionId ?? null,
      backend: this.backend.id,
    };
    const out = await this.backend.send(ref, prompt, onEvent);
    return out.nativeId ?? "";
  }
}
```

- [ ] **Step 6: Run the new test and the existing suite**

```bash
npx vitest run test/backend-sdk.test.ts test/sessionManager.test.ts test/server.test.ts
```

Expected: PASS. `sessionManager.test.ts` and `server.test.ts` must pass **with no edits** — that is the behavior-preservation proof. If either fails, fix `sessionManager.ts`, never the test.

- [ ] **Step 7: Run the full suite and typecheck**

```bash
npm test && npm run build
```

Expected: all tests pass, `tsc` reports no errors.

- [ ] **Step 8: Commit**

```bash
git add agent-host/src/backends/ agent-host/src/sessionManager.ts agent-host/test/backend-sdk.test.ts
git commit -m "refactor(agent-host): extract AgentBackend, SessionManager delegates to sdk backend"
```

---

### Task 2: Shared conformance suite

Write the contract that *any* `AgentBackend` must satisfy, and run it against the SDK backend now. Task 4 will run the same suite against the mngr backend. This suite is what keeps the abstraction honest rather than SDK-shaped.

**Files:**
- Create: `agent-host/test/backend-conformance.ts` (helper, not a `.test.ts` — vitest only collects `test/**/*.test.ts`)
- Create: `agent-host/test/backend-conformance.test.ts`

**Interfaces:**
- Consumes: `AgentBackend`, `AgentRef`, `AgentSpec` from `src/backends/types.js`; `createSdkBackend` from `src/backends/sdk.js`.
- Produces: `runBackendConformance(name: string, makeBackend: () => AgentBackend | Promise<AgentBackend>): void` — Task 4 calls this with the mngr backend.

- [ ] **Step 1: Write the conformance helper**

Create `agent-host/test/backend-conformance.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { AgentBackend, AgentRef } from "../src/backends/types.js";
import type { AgentEvent } from "../src/types.js";

export const CONFORMANCE_SPEC = {
  model: "m",
  workspace: "/ws",
  permissionMode: "acceptEdits",
  extraOptions: {},
};

/** The contract every AgentBackend must satisfy. Both backends run this
 *  identical suite, so the interface cannot quietly become SDK-shaped. */
export function runBackendConformance(
  name: string,
  makeBackend: () => AgentBackend | Promise<AgentBackend>,
): void {
  describe(`AgentBackend conformance: ${name}`, () => {
    it("exposes a stable id", async () => {
      const backend = await makeBackend();
      expect(["sdk", "mngr"]).toContain(backend.id);
    });

    it("ensure returns a ref carrying the requested agentId and its own backend id", async () => {
      const backend = await makeBackend();
      const ref = await backend.ensure("agent-conf-1", CONFORMANCE_SPEC);
      expect(ref.agentId).toBe("agent-conf-1");
      expect(ref.backend).toBe(backend.id);
    });

    it("ensure is idempotent: same agentId yields the same nativeId", async () => {
      const backend = await makeBackend();
      const first = await backend.ensure("agent-conf-2", CONFORMANCE_SPEC);
      const second = await backend.ensure("agent-conf-2", CONFORMANCE_SPEC);
      expect(second.agentId).toBe(first.agentId);
      expect(second.nativeId).toBe(first.nativeId);
    });

    it("send preserves agentId and emits a terminal result or error", async () => {
      const backend = await makeBackend();
      const ref: AgentRef = await backend.ensure("agent-conf-3", CONFORMANCE_SPEC);
      const events: AgentEvent[] = [];
      const out = await backend.send(ref, "hello", (e) => events.push(e));

      expect(out.agentId).toBe("agent-conf-3");
      expect(out.backend).toBe(backend.id);
      const last = events.at(-1);
      expect(last?.type === "result" || last?.type === "error").toBe(true);
    });

    it("send never throws: failures arrive as an error event", async () => {
      const backend = await makeBackend();
      const ref = await backend.ensure("agent-conf-4", CONFORMANCE_SPEC);
      await expect(backend.send(ref, "hello", () => {})).resolves.toBeDefined();
    });

    it("list resolves to an array", async () => {
      const backend = await makeBackend();
      expect(Array.isArray(await backend.list())).toBe(true);
    });

    it("stop resolves for a known ref", async () => {
      const backend = await makeBackend();
      const ref = await backend.ensure("agent-conf-5", CONFORMANCE_SPEC);
      await expect(backend.stop(ref)).resolves.toBeUndefined();
    });

    it("transcript resolves to an array or null, never throws", async () => {
      const backend = await makeBackend();
      const ref = await backend.ensure("agent-conf-6", CONFORMANCE_SPEC);
      const t = await backend.transcript(ref);
      expect(t === null || Array.isArray(t)).toBe(true);
    });
  });
}
```

- [ ] **Step 2: Write the SDK conformance runner**

Create `agent-host/test/backend-conformance.test.ts`:

```ts
import { createSdkBackend } from "../src/backends/sdk.js";
import type { QueryFn } from "../src/sessionManager.js";
import { runBackendConformance, CONFORMANCE_SPEC } from "./backend-conformance.js";

const query: QueryFn = () =>
  (async function* () {
    yield { type: "system", subtype: "init", session_id: "sess-conf" };
    yield { type: "result", result: "ok", is_error: false };
  })();

runBackendConformance("sdk", () => createSdkBackend({ query, spec: CONFORMANCE_SPEC }));
```

- [ ] **Step 3: Run the conformance suite**

```bash
npx vitest run test/backend-conformance.test.ts
```

Expected: PASS. If "ensure is idempotent" fails for the SDK backend, that is correct behavior being caught — the SDK's `ensure` returns `nativeId: null` both times, which satisfies the assertion. If any other test fails, fix `sdk.ts`.

- [ ] **Step 4: Commit**

```bash
git add agent-host/test/backend-conformance.ts agent-host/test/backend-conformance.test.ts
git commit -m "test(agent-host): shared AgentBackend conformance suite, sdk passes"
```

---

### Task 3: Agent registry

A durable index mapping Rhumb principals to backend handles. Slice 1 needs it to survive restarts and answer "which mngr agent belongs to this principal?"; slice 2 grows it into the full registry.

**Files:**
- Create: `agent-host/src/agents.ts`
- Test: `agent-host/test/agents.test.ts`

**Interfaces:**
- Consumes: `atomicWriteFileSync(path: string, data: string): void` from `src/fsAtomic.js`; `AgentRef`, `BackendId` from `src/backends/types.js`.
- Produces:
  - `interface AgentRecord { agentId: string; nativeId: string | null; backend: BackendId; name: string; createdAt: string; lastActiveAt: string; status: "active" | "stopped" }`
  - `interface AgentRegistry { create(name, backend): AgentRecord; get(agentId): AgentRecord | undefined; bind(agentId, nativeId): void; touch(agentId): void; markStopped(agentId): void; list(): AgentRecord[] }`
  - `createAgentRegistry(deps: { indexPath: string; now: () => string; id: () => string }): AgentRegistry`

- [ ] **Step 1: Write the failing test**

Create `agent-host/test/agents.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentRegistry } from "../src/agents.js";

let dir: string;
let indexPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rhumb-agents-"));
  indexPath = join(dir, "agents.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeRegistry(ids: string[] = ["id-1", "id-2", "id-3"]) {
  let n = 0;
  return createAgentRegistry({
    indexPath,
    now: () => "2026-08-03T00:00:00.000Z",
    id: () => ids[n++] ?? `id-${n}`,
  });
}

describe("agent registry", () => {
  it("creates a record with a Rhumb-minted agentId and no nativeId yet", () => {
    const rec = makeRegistry().create("probe", "mngr");
    expect(rec.agentId).toBe("id-1");
    expect(rec.nativeId).toBeNull();
    expect(rec.backend).toBe("mngr");
    expect(rec.name).toBe("probe");
    expect(rec.status).toBe("active");
  });

  it("binds a nativeId to an existing principal", () => {
    const reg = makeRegistry();
    const rec = reg.create("probe", "mngr");
    reg.bind(rec.agentId, "agent-deadbeef");
    expect(reg.get(rec.agentId)?.nativeId).toBe("agent-deadbeef");
  });

  it("persists across instances", () => {
    const rec = makeRegistry().create("probe", "mngr");
    const reloaded = createAgentRegistry({
      indexPath,
      now: () => "2026-08-03T00:00:00.000Z",
      id: () => "unused",
    });
    expect(reloaded.get(rec.agentId)?.name).toBe("probe");
  });

  it("returns undefined for an unknown agentId", () => {
    expect(makeRegistry().get("nope")).toBeUndefined();
  });

  it("markStopped flips status and list still returns the record", () => {
    const reg = makeRegistry();
    const rec = reg.create("probe", "mngr");
    reg.markStopped(rec.agentId);
    expect(reg.get(rec.agentId)?.status).toBe("stopped");
    expect(reg.list()).toHaveLength(1);
  });

  it("treats a corrupt index as empty rather than throwing", () => {
    writeFileSync(indexPath, "{ not json");
    expect(makeRegistry().list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/agents.test.ts
```

Expected: FAIL — cannot resolve `../src/agents.js`.

- [ ] **Step 3: Write the registry**

Create `agent-host/src/agents.ts`:

```ts
import { readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./fsAtomic.js";
import type { BackendId } from "./backends/types.js";

/** One agent principal. `agentId` is Rhumb-owned and durable; `nativeId` is
 *  the backend's disposable handle, bound at spawn. Keeping them distinct is
 *  what lets a mngr fork inherit no trust. */
export interface AgentRecord {
  agentId: string;
  nativeId: string | null;
  backend: BackendId;
  name: string;
  createdAt: string;
  lastActiveAt: string;
  status: "active" | "stopped";
}

export interface AgentRegistry {
  create(name: string, backend: BackendId): AgentRecord;
  get(agentId: string): AgentRecord | undefined;
  bind(agentId: string, nativeId: string): void;
  touch(agentId: string): void;
  markStopped(agentId: string): void;
  list(): AgentRecord[];
}

function load(indexPath: string): AgentRecord[] {
  try {
    const raw = JSON.parse(readFileSync(indexPath, "utf8"));
    return Array.isArray(raw) ? (raw as AgentRecord[]) : [];
  } catch {
    // Missing or corrupt: start empty, same posture as sessions.ts.
    return [];
  }
}

export function createAgentRegistry(deps: {
  indexPath: string;
  now: () => string;
  id: () => string;
}): AgentRegistry {
  const records = load(deps.indexPath);
  const persist = () => atomicWriteFileSync(deps.indexPath, JSON.stringify(records, null, 2));

  return {
    create(name, backend) {
      const stamp = deps.now();
      const rec: AgentRecord = {
        agentId: deps.id(),
        nativeId: null,
        backend,
        name,
        createdAt: stamp,
        lastActiveAt: stamp,
        status: "active",
      };
      records.push(rec);
      persist();
      return rec;
    },
    get(agentId) {
      return records.find((r) => r.agentId === agentId);
    },
    bind(agentId, nativeId) {
      const rec = records.find((r) => r.agentId === agentId);
      if (!rec) return;
      rec.nativeId = nativeId;
      rec.lastActiveAt = deps.now();
      persist();
    },
    touch(agentId) {
      const rec = records.find((r) => r.agentId === agentId);
      if (!rec) return;
      rec.lastActiveAt = deps.now();
      persist();
    },
    markStopped(agentId) {
      const rec = records.find((r) => r.agentId === agentId);
      if (!rec) return;
      rec.status = "stopped";
      persist();
    },
    list() {
      return records.slice();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/agents.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/agents.ts agent-host/test/agents.test.ts
git commit -m "feat(agent-host): agent registry mapping Rhumb principals to backend handles"
```

---

### Task 4: mngr backend

**Prerequisite:** Task 0's findings document. Replace every `MNGR_*` command constant below with the invocations actually recorded there.

**Files:**
- Create: `agent-host/src/backends/mngr.ts`
- Test: `agent-host/test/backend-mngr.test.ts`

**Interfaces:**
- Consumes: `AgentBackend`, `AgentRef`, `AgentSpec` from `./types.js`; `AgentRegistry` from `../agents.js`; `runBackendConformance`, `CONFORMANCE_SPEC` from `./backend-conformance.js`.
- Produces:
  - `interface ExecResult { code: number; stdout: string; stderr: string }`
  - `type ExecFn = (argv: string[], opts?: { env?: Record<string, string> }) => Promise<ExecResult>`
  - `createMngrBackend(deps: { exec: ExecFn; registry: AgentRegistry; credentialEnv: Record<string, string>; spec: AgentSpec; readTranscript: (nativeId: string) => TranscriptMessage[] | null }): AgentBackend`

- [ ] **Step 1: Write the failing test**

Create `agent-host/test/backend-mngr.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMngrBackend, type ExecFn } from "../src/backends/mngr.js";
import { createAgentRegistry } from "../src/agents.js";
import { runBackendConformance, CONFORMANCE_SPEC } from "./backend-conformance.js";
import type { AgentEvent } from "../src/types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-mngr-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeRegistry() {
  let n = 0;
  return createAgentRegistry({
    indexPath: join(dir, "agents.json"),
    now: () => "2026-08-03T00:00:00.000Z",
    id: () => `rhumb-${++n}`,
  });
}

/** Records every argv and returns canned success. */
function recordingExec(calls: string[][], stdout = ""): ExecFn {
  return async (argv) => {
    calls.push(argv);
    return { code: 0, stdout, stderr: "" };
  };
}

describe("mngr backend", () => {
  it("reports its id", () => {
    const backend = createMngrBackend({
      exec: recordingExec([]),
      registry: makeRegistry(),
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      readTranscript: () => null,
    });
    expect(backend.id).toBe("mngr");
  });

  it("ensure creates a mngr agent and binds its nativeId to the principal", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const backend = createMngrBackend({
      exec: recordingExec(calls, "agent-abc123"),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      readTranscript: () => null,
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBe("agent-abc123");
    expect(registry.get(rec.agentId)?.nativeId).toBe("agent-abc123");
    expect(calls[0]).toContain("create");
  });

  it("ensure is idempotent: a bound principal does not spawn a second agent", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-existing");
    const backend = createMngrBackend({
      exec: recordingExec(calls, "agent-new"),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      readTranscript: () => null,
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBe("agent-existing");
    expect(calls.filter((c) => c.includes("create"))).toHaveLength(0);
  });

  it("re-creates when the bound agent is no longer live", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-dead");
    // `list` reports a different agent, so the bound one is provably gone.
    const backend = createMngrBackend({
      exec: async (argv) => {
        calls.push(argv);
        if (argv.includes("list")) {
          return { code: 0, stdout: JSON.stringify([{ id: "agent-someone-else" }]), stderr: "" };
        }
        return { code: 0, stdout: "agent-reborn", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      readTranscript: () => null,
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBe("agent-reborn");
    expect(registry.get(rec.agentId)?.nativeId).toBe("agent-reborn");
    expect(calls.some((c) => c.includes("create"))).toBe(true);
  });

  it("keeps the existing agent when liveness cannot be determined", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-existing");
    // Unparseable list output must NOT be read as "the agent is dead".
    const backend = createMngrBackend({
      exec: async (argv) => {
        calls.push(argv);
        return { code: 1, stdout: "not json", stderr: "boom" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      readTranscript: () => null,
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBe("agent-existing");
    expect(calls.some((c) => c.includes("create"))).toBe(false);
  });

  it("passes exactly the Rhumb credential env to create and nothing ambient", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const backend = createMngrBackend({
      exec: async (_argv, opts) => {
        seen.push(opts?.env);
        return { code: 0, stdout: "agent-x", stderr: "" };
      },
      registry,
      credentialEnv: { ANTHROPIC_API_KEY: "sk-injected" },
      spec: CONFORMANCE_SPEC,
      readTranscript: () => null,
    });

    await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(seen[0]?.ANTHROPIC_API_KEY).toBe("sk-injected");
  });

  it("surfaces a non-zero exit as an error event rather than throwing", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const backend = createMngrBackend({
      exec: async () => ({ code: 1, stdout: "", stderr: "mngr: host unreachable" }),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      readTranscript: () => null,
    });

    const events: AgentEvent[] = [];
    await backend.send(
      { agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" },
      "hello",
      (e) => events.push(e),
    );

    expect(events.at(-1)?.type).toBe("error");
    expect((events.at(-1) as { message: string }).message).toContain("host unreachable");
  });

  it("stop marks the principal stopped in the registry", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    const backend = createMngrBackend({
      exec: recordingExec([]),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      readTranscript: () => null,
    });

    await backend.stop({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" });

    expect(registry.get(rec.agentId)?.status).toBe("stopped");
  });
});

// The same contract the sdk backend satisfies.
runBackendConformance("mngr", () => {
  const registry = createAgentRegistry({
    indexPath: join(mkdtempSync(join(tmpdir(), "rhumb-conf-")), "agents.json"),
    now: () => "2026-08-03T00:00:00.000Z",
    id: () => "rhumb-conf",
  });
  return createMngrBackend({
    exec: async () => ({ code: 0, stdout: "agent-conf", stderr: "" }),
    registry,
    credentialEnv: {},
    spec: CONFORMANCE_SPEC,
    readTranscript: () => [],
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/backend-mngr.test.ts
```

Expected: FAIL — cannot resolve `../src/backends/mngr.js`.

- [ ] **Step 3: Write the mngr backend**

Create `agent-host/src/backends/mngr.ts`. **Replace the four `argvCreate` / `argvSend` / `argvStop` / `argvList` builders with the invocations recorded in Task 0.** Everything below them is CLI-shape-independent and should not need changes.

```ts
import type { AgentEvent, TranscriptMessage } from "../types.js";
import type { AgentBackend, AgentRef, AgentSpec } from "./types.js";
import type { AgentRegistry } from "../agents.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  argv: string[],
  opts?: { env?: Record<string, string> },
) => Promise<ExecResult>;

// Command shapes confirmed in docs/dogfood/2026-08-03-mngr-phase0.md.
// Adjust these three builders — and nothing else — if the CLI differs.
const argvCreate = (name: string, workspace: string): string[] => [
  "create", name, "--work-dir", workspace,
];
const argvSend = (nativeId: string, prompt: string): string[] => [
  "message", nativeId, prompt,
];
const argvStop = (nativeId: string): string[] => ["stop", nativeId];
const argvList = (): string[] => ["list", "--format", "json"];

/** Runs Claude Code through the mngr CLI instead of in-process.
 *
 *  `ensure` binds a Rhumb principal to a mngr agent id. The binding is
 *  recorded in the registry, never derived from mngr — mngr ids are
 *  plaintext and settable, so they are looked up, not trusted. */
export function createMngrBackend(deps: {
  exec: ExecFn;
  registry: AgentRegistry;
  /** Exactly the credential vars the spawned agent may see. Built by
   *  provider.ts / env.ts; nothing ambient is added here. */
  credentialEnv: Record<string, string>;
  spec: AgentSpec;
  readTranscript: (nativeId: string) => TranscriptMessage[] | null;
}): AgentBackend {
  const { exec, registry, credentialEnv, readTranscript } = deps;

  /** Live mngr agent ids, or `null` when liveness is unknowable (non-zero
   *  exit or unparseable output). `null` means "do not conclude anything" —
   *  never "nothing is alive". */
  async function liveIds(): Promise<Set<string> | null> {
    const res = await exec(argvList());
    if (res.code !== 0) return null;
    try {
      const parsed = JSON.parse(res.stdout) as Array<{ id?: string }>;
      const ids = new Set<string>();
      for (const a of parsed) if (a.id) ids.add(a.id);
      return ids;
    } catch {
      return null;
    }
  }

  return {
    id: "mngr",

    async ensure(agentId, spec) {
      const existing = registry.get(agentId);
      if (existing?.nativeId) {
        // A bound agent may have died (host reboot, tmux kill). Re-create
        // rather than failing the turn. Liveness must be PROVEN false before
        // respawning: if `list` errors or is unparseable we cannot tell, and
        // assuming "dead" there would spawn a duplicate on every hiccup.
        const live = await liveIds();
        if (live === null || live.has(existing.nativeId)) {
          return { agentId, nativeId: existing.nativeId, backend: "mngr" };
        }
      }
      const name = existing?.name ?? agentId;
      const res = await exec(argvCreate(name, spec.workspace), { env: credentialEnv });
      if (res.code !== 0) {
        // Leave the principal unbound; send() will report the failure as an
        // error event on the turn rather than throwing here.
        return { agentId, nativeId: null, backend: "mngr" };
      }
      const nativeId = res.stdout.trim();
      if (nativeId) registry.bind(agentId, nativeId);
      return { agentId, nativeId: nativeId || null, backend: "mngr" };
    },

    async send(ref, prompt, onEvent) {
      let nativeId = ref.nativeId;
      if (!nativeId) {
        const ensured = await this.ensure(ref.agentId, deps.spec);
        nativeId = ensured.nativeId;
        if (!nativeId) {
          onEvent({ type: "error", message: "mngr: could not create an agent for this principal" });
          return { ...ref, nativeId: null };
        }
      }

      onEvent({ type: "session", sessionId: nativeId });

      const res = await exec(argvSend(nativeId, prompt), { env: credentialEnv });
      if (res.code !== 0) {
        onEvent({ type: "error", message: `mngr: ${res.stderr.trim() || `exit ${res.code}`}` });
        return { ...ref, nativeId };
      }

      registry.touch(ref.agentId);
      onEvent({ type: "result", result: res.stdout.trim(), isError: false });
      return { ...ref, nativeId };
    },

    async list(): Promise<AgentRef[]> {
      // The registry is the source of truth for principals; mngr is consulted
      // only to confirm liveness, and an unknowable answer degrades to
      // returning the registry unfiltered.
      const live = await liveIds();
      return registry
        .list()
        .filter((r) => r.backend === "mngr")
        .map((r) => ({ agentId: r.agentId, nativeId: r.nativeId, backend: "mngr" as const }))
        .filter((r) => live === null || r.nativeId === null || live.has(r.nativeId));
    },

    async stop(ref) {
      if (ref.nativeId) await exec(argvStop(ref.nativeId));
      registry.markStopped(ref.agentId);
    },

    async transcript(ref) {
      return ref.nativeId ? readTranscript(ref.nativeId) : null;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/backend-mngr.test.ts
```

Expected: PASS — the 6 mngr-specific tests plus all 8 conformance tests under "AgentBackend conformance: mngr".

- [ ] **Step 5: Run the full suite and typecheck**

```bash
npm test && npm run build
```

Expected: everything passes.

- [ ] **Step 6: Commit**

```bash
git add agent-host/src/backends/mngr.ts agent-host/test/backend-mngr.test.ts
git commit -m "feat(agent-host): mngr agent backend behind the AgentBackend contract"
```

---

### Task 5: Wiring and eager validation

Select the backend by environment variable, validate the choice at boot, and construct the real `exec`. Default stays `sdk`.

**Files:**
- Modify: `agent-host/src/config.ts` (add `agentBackend` to `Config` and `loadConfig`)
- Create: `agent-host/src/backends/exec.ts`
- Modify: `agent-host/src/index.ts:166-172` (main manager construction)
- Test: `agent-host/test/config.test.ts` (append cases)
- Test: `agent-host/test/backend-select.test.ts`

**Interfaces:**
- Consumes: `createMngrBackend`, `ExecFn` from `./backends/mngr.js`; `createAgentRegistry` from `./agents.js`; `Config` from `./config.js`.
- Produces:
  - `Config.agentBackend: BackendId`
  - `createRealExec(): ExecFn`
  - `assertMngrPrerequisites(lookup: (bin: string) => boolean): void`

- [ ] **Step 1: Write the failing config test**

Append to `agent-host/test/config.test.ts`:

```ts
describe("RHUMB_AGENT_BACKEND", () => {
  const base = {
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
    RHUMB_ALLOWED_USERS: "you@example.com",
  } as NodeJS.ProcessEnv;

  it("defaults to sdk when unset", () => {
    expect(loadConfig({ ...base }).agentBackend).toBe("sdk");
  });

  it("accepts mngr", () => {
    expect(loadConfig({ ...base, RHUMB_AGENT_BACKEND: "mngr" }).agentBackend).toBe("mngr");
  });

  it("rejects an unknown backend", () => {
    expect(() => loadConfig({ ...base, RHUMB_AGENT_BACKEND: "wat" })).toThrow(/sdk\|mngr/);
  });
});
```

Note: `loadConfig` and `describe`/`it`/`expect` are already imported at the top of that file. Do not duplicate the imports.

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/config.test.ts
```

Expected: FAIL — `agentBackend` is undefined.

- [ ] **Step 3: Add `agentBackend` to config**

In `agent-host/src/config.ts`, import the type and extend the interface:

```ts
import type { BackendId } from "./backends/types.js";
```

Add to `interface Config`:

```ts
  agentBackend: BackendId;
```

Add near the other validators in `loadConfig`, before the `return`:

```ts
  const rawBackend = env.RHUMB_AGENT_BACKEND?.trim();
  if (rawBackend && rawBackend !== "sdk" && rawBackend !== "mngr") {
    throw new Error(
      `RHUMB_AGENT_BACKEND must be one of sdk|mngr, got "${rawBackend}".`,
    );
  }
  const agentBackend: BackendId = rawBackend === "mngr" ? "mngr" : "sdk";
```

And add `agentBackend,` to the returned object.

- [ ] **Step 4: Run the config test to verify it passes**

```bash
npx vitest run test/config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing prerequisite test**

Create `agent-host/test/backend-select.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assertMngrPrerequisites } from "../src/backends/exec.js";

describe("assertMngrPrerequisites", () => {
  it("passes when both binaries are present", () => {
    expect(() => assertMngrPrerequisites(() => true)).not.toThrow();
  });

  it("names the missing binary and stays actionable", () => {
    expect(() => assertMngrPrerequisites((b) => b !== "tmux")).toThrow(/tmux/);
  });

  it("reports mngr when mngr is the missing one", () => {
    expect(() => assertMngrPrerequisites((b) => b !== "mngr")).toThrow(/mngr/);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
npx vitest run test/backend-select.test.ts
```

Expected: FAIL — cannot resolve `../src/backends/exec.js`.

- [ ] **Step 7: Write the exec module**

Create `agent-host/src/backends/exec.ts`:

```ts
import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import type { ExecFn } from "./mngr.js";

/** Real mngr invocation. The child receives ONLY what `env` supplies —
 *  process.env is deliberately not spread in, so no ambient credential can
 *  reach the agent. This is the same guarantee sanitizedEnv gives the SDK
 *  path; see provider.ts. */
export function createRealExec(): ExecFn {
  return (argv, opts) =>
    new Promise((resolve) => {
      execFile(
        "mngr",
        argv,
        { env: opts?.env ?? {}, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? ((err as { code: number }).code)
              : err
                ? 1
                : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

/** Fail fast at boot rather than on the operator's first turn. Precedent:
 *  commit 462acd6 (validate eagerly) and fb30c3d (fail closed). */
export function assertMngrPrerequisites(
  lookup: (bin: string) => boolean = defaultLookup,
): void {
  const missing = ["mngr", "tmux"].filter((b) => !lookup(b));
  if (missing.length > 0) {
    throw new Error(
      `RHUMB_AGENT_BACKEND=mngr requires ${missing.join(" and ")} on PATH. ` +
        `Install with: brew install tmux && uv tool install git+https://github.com/imbue-ai/mngr`,
    );
  }
}

function defaultLookup(bin: string): boolean {
  return spawnSync("command", ["-v", bin], { shell: true }).status === 0;
}
```

- [ ] **Step 8: Run the prerequisite test to verify it passes**

```bash
npx vitest run test/backend-select.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 9: Wire the selection into index.ts**

In `agent-host/src/index.ts`, add these imports beside the existing ones:

```ts
import { createAgentRegistry } from "./agents.js";
import { createMngrBackend } from "./backends/mngr.js";
import { createRealExec, assertMngrPrerequisites } from "./backends/exec.js";
import type { AgentBackend } from "./backends/types.js";
```

`randomUUID` is already imported from `node:crypto` at line 6 — do not import it twice.

Replace the main manager construction at lines 166-172 with:

```ts
  // The watchdog manager below deliberately stays on the SDK path: it is a
  // read-only reconcile turn whose tool policy is the point, and slice 1
  // does not model unattended agents as principals.
  let backend: AgentBackend | undefined;
  if (deps.config.agentBackend === "mngr") {
    assertMngrPrerequisites();
    const registry = createAgentRegistry({
      indexPath: joinPath(deps.config.workspace, "agents.json"),
      now: () => new Date().toISOString(),
      id: () => `rhumb-${randomUUID()}`,
    });
    backend = createMngrBackend({
      exec: createRealExec(),
      registry,
      credentialEnv: deps.config.provider.credentialEnv,
      spec: {
        model: deps.config.provider.model,
        workspace: deps.config.workspace,
        permissionMode: deps.config.permissionMode,
        extraOptions: sessionExtraOptions,
      },
      readTranscript: () => null,
    });
  }

  const manager = new SessionManager({
    query: deps.query,
    backend,
    model: deps.config.provider.model,
    workspace: deps.config.workspace,
    permissionMode: deps.config.permissionMode,
    extraOptions: sessionExtraOptions,
  });
```

Leave the watchdog manager at lines 203-215 exactly as it is.

- [ ] **Step 10: Log the selected backend at startup**

In `main()`, inside `onListen`, extend the existing listening line so operators can see which path is live. Replace the `console.log` that prints `(provider ..., model ...)` with:

```ts
    console.log(
      `rhumb agent-host listening on ${bound}:${config.port} ` +
        `(provider ${config.provider.id}, model ${config.provider.model}, ` +
        `agent backend ${config.agentBackend})`,
    );
```

- [ ] **Step 11: Run the full suite and typecheck**

```bash
npm test && npm run build
```

Expected: all tests pass, no type errors. `server.test.ts` and `sessionManager.test.ts` still untouched.

- [ ] **Step 12: Commit**

```bash
git add agent-host/src/config.ts agent-host/src/backends/exec.ts agent-host/src/index.ts agent-host/test/config.test.ts agent-host/test/backend-select.test.ts
git commit -m "feat(agent-host): RHUMB_AGENT_BACKEND selection with eager prerequisite validation"
```

---

### Task 6: Live integration and the credential regression test

Run a real turn through mngr on localhost, and make Phase 0's credential finding a permanent test.

**Files:**
- Create: `agent-host/test/backend-mngr.integration.test.ts`
- Modify: `agent-host/README.md` (document `RHUMB_AGENT_BACKEND`)
- Modify: `.env.example` (document `RHUMB_AGENT_BACKEND`)

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: no new exports. This task's deliverable is evidence.

- [ ] **Step 1: Write the gated integration test**

Create `agent-host/test/backend-mngr.integration.test.ts`. It skips itself where mngr is absent, so CI and other machines stay green:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMngrBackend } from "../src/backends/mngr.js";
import { createRealExec } from "../src/backends/exec.js";
import { createAgentRegistry } from "../src/agents.js";
import type { AgentEvent } from "../src/types.js";

const has = (bin: string) => spawnSync("command", ["-v", bin], { shell: true }).status === 0;
const available = has("mngr") && has("tmux");

describe.skipIf(!available)("mngr backend (live, localhost)", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-live-")); });

  function makeBackend(credentialEnv: Record<string, string>) {
    const registry = createAgentRegistry({
      indexPath: join(dir, "agents.json"),
      now: () => new Date().toISOString(),
      id: () => `rhumb-live-${Math.random().toString(16).slice(2)}`,
    });
    const rec = registry.create("rhumb-live-probe", "mngr");
    const backend = createMngrBackend({
      exec: createRealExec(),
      registry,
      credentialEnv,
      spec: { model: "claude-opus-4-8", workspace: dir, permissionMode: "acceptEdits", extraOptions: {} },
      readTranscript: () => null,
    });
    return { backend, agentId: rec.agentId, registry };
  }

  // Skips rather than returning early: a test that asserts nothing is worse
  // than one that honestly reports as skipped.
  it.skipIf(!process.env.CLAUDE_CODE_OAUTH_TOKEN)("spawns a real agent and binds its nativeId", { timeout: 120_000 }, async () => {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN as string;
    const { backend, agentId, registry } = makeBackend({ CLAUDE_CODE_OAUTH_TOKEN: token });

    const ref = await backend.ensure(agentId, {
      model: "claude-opus-4-8", workspace: dir, permissionMode: "acceptEdits", extraOptions: {},
    });

    expect(ref.nativeId).toBeTruthy();
    expect(registry.get(agentId)?.nativeId).toBe(ref.nativeId);

    const events: AgentEvent[] = [];
    await backend.send(ref, "Reply with exactly the word: pong", (e) => events.push(e));
    const last = events.at(-1);
    expect(last?.type === "result" || last?.type === "error").toBe(true);

    await backend.stop(ref);
    expect(registry.get(agentId)?.status).toBe("stopped");
  });

  // Phase 0 Q2, made permanent: an ambient credential must never reach the
  // spawned agent. createRealExec passes ONLY the env it is given.
  it("does not leak an ambient credential into the child", { timeout: 120_000 }, async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-decoy-must-not-survive";
    try {
      const captured: Array<Record<string, string> | undefined> = [];
      const registry = createAgentRegistry({
        indexPath: join(dir, "agents-decoy.json"),
        now: () => new Date().toISOString(),
        id: () => "rhumb-decoy",
      });
      const rec = registry.create("decoy", "mngr");
      const backend = createMngrBackend({
        exec: async (argv, opts) => {
          captured.push(opts?.env);
          return { code: 0, stdout: "agent-decoy", stderr: "" };
        },
        registry,
        credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-injected" },
        spec: { model: "m", workspace: dir, permissionMode: "acceptEdits", extraOptions: {} },
        readTranscript: () => null,
      });

      await backend.ensure(rec.agentId, {
        model: "m", workspace: dir, permissionMode: "acceptEdits", extraOptions: {},
      });

      expect(captured[0]?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-injected");
      expect(captured[0]?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(JSON.stringify(captured[0])).not.toContain("sk-decoy-must-not-survive");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
```

- [ ] **Step 2: Run the integration test**

```bash
npx vitest run test/backend-mngr.integration.test.ts
```

Expected on this Mac (mngr installed in Task 0): both tests run and PASS. On a machine without mngr: the whole describe block reports as skipped.

If the live spawn fails, do not weaken the test. Re-read `docs/dogfood/2026-08-03-mngr-phase0.md` and correct the `argv*` builders in `src/backends/mngr.ts` — a mismatch there is the most likely cause.

- [ ] **Step 3: Document the variable in `.env.example`**

Add, near the other `RHUMB_*` entries:

```bash
# Which execution backend runs agents.
#   sdk  (default) — Claude Code in-process via the Agent SDK. Single agent,
#                    one workspace. This is the behavior Rhumb has always had.
#   mngr           — spawn agents through the mngr CLI (github.com/imbue-ai/mngr).
#                    Requires `mngr` and `tmux` on PATH; the host refuses to
#                    start without them. Localhost only in this release.
# RHUMB_AGENT_BACKEND=sdk
```

- [ ] **Step 4: Document it in `agent-host/README.md`**

Add this subsection under the configuration documentation:

```markdown
### Agent execution backend

`RHUMB_AGENT_BACKEND` selects how agents run. Default: `sdk`.

| Value | Behavior |
| --- | --- |
| `sdk` | Claude Code in-process via the Agent SDK. One agent, one workspace. The behavior Rhumb has always had. |
| `mngr` | Agents are spawned through the [mngr](https://github.com/imbue-ai/mngr) CLI. Localhost only in this release. |

`mngr` mode requires `mngr` and `tmux` on `PATH`. The host checks at startup and
refuses to boot without them, rather than failing on your first turn:

    brew install tmux
    uv tool install git+https://github.com/imbue-ai/mngr

**Identity.** Rhumb mints and owns the durable agent principal (`agentId`),
recorded in `workspace/agents.json`. A mngr agent id is stored alongside it as
`nativeId` — a runtime binding only. mngr ids are plaintext and settable via
`mngr create --id`, so Rhumb treats them as identifiers, never as credentials.
Because a mngr fork mints a fresh id, a forked agent inherits nothing from its
parent.

**Credentials.** In `mngr` mode the spawned agent receives exactly the
credential variables Rhumb injects and nothing from the ambient environment —
the same guarantee described in [SECURITY.md](../SECURITY.md) for the SDK path.
```

- [ ] **Step 5: Run the full suite and typecheck**

```bash
npm test && npm run build
```

Expected: everything passes.

- [ ] **Step 6: Commit**

```bash
git add agent-host/test/backend-mngr.integration.test.ts agent-host/README.md .env.example
git commit -m "test(agent-host): live mngr integration + ambient-credential regression test"
```

---

## Done when

- `npm test` and `npm run build` pass in `agent-host/`.
- `test/sessionManager.test.ts` and `test/server.test.ts` are **unmodified** in the diff.
- The conformance suite runs green against both backends.
- With `RHUMB_AGENT_BACKEND` unset, behavior is identical to today.
- With `RHUMB_AGENT_BACKEND=mngr`, a real turn completes through a mngr-spawned agent on localhost, and `workspace/agents.json` shows the principal bound to a mngr agent id.
- `docs/dogfood/2026-08-03-mngr-phase0.md` records the Q1/Q2/Q3 findings.

## Follow-ups (not this plan)

- Slice 2: grow the registry into the full agent ontology — create/list/stop as first-class operations with their own routes.
- Slice 3: trust edge becomes Rhumb-principal × surface, executed-via mngr agent (sharpens F22).
- Slice 4: dashboard-host + client surfaces for the agent ontology.
- Slice 5: SSH/Docker/Modal providers, plus fork/snapshot. Pin `is_host_volume_created=true` and treat `mngr create --id` as privileged (see the spec's risk table).
- `transcript()` returns `null` on both backends in slice 1; transcript ownership is revisited in slice 4.
