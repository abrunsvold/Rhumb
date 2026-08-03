import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMngrBackend, type ExecFn } from "../src/backends/mngr.js";
import { createAgentRegistry } from "../src/agents.js";
import { PROVIDER_CREDENTIAL_VARS } from "../src/provider.js";
import { runBackendConformance, CONFORMANCE_SPEC } from "./backend-conformance.js";
import type { AgentEvent } from "../src/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rhumb-mngr-"));
});
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
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBe("agent-abc123");
    expect(registry.get(rec.agentId)?.nativeId).toBe("agent-abc123");
    expect(calls[0]).toContain("create");
    // create must invoke the verified mngr CLI shape: create <name> claude
    // --no-connect -y ...
    expect(calls[0]).toEqual(
      expect.arrayContaining(["create", rec.name, "claude", "--no-connect", "-y"]),
    );
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
    // `list --format json` reports a different agent under the "agents" key,
    // so the bound one is provably gone.
    const backend = createMngrBackend({
      exec: async (argv) => {
        calls.push(argv);
        if (argv.includes("list")) {
          return {
            code: 0,
            stdout: JSON.stringify({ agents: [{ id: "agent-someone-else" }] }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "agent-reborn", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
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
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBe("agent-existing");
    expect(calls.some((c) => c.includes("create"))).toBe(false);
  });

  it("also treats a well-formed list without an agents array as unknown liveness", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-existing");
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv.includes("list")) {
          // A bare array, as the invalidated brief assumed — must NOT be
          // read as "empty and therefore nothing is alive".
          return { code: 0, stdout: JSON.stringify([{ id: "agent-existing" }]), stderr: "" };
        }
        return { code: 0, stdout: "agent-new", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    // Unparseable-as-expected-shape list output must not trigger a respawn.
    expect(ref.nativeId).toBe("agent-existing");
  });

  it("create blanks every PROVIDER_CREDENTIAL_VARS entry not present in credentialEnv", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const backend = createMngrBackend({
      exec: recordingExec(calls, "agent-x"),
      registry,
      credentialEnv: { ANTHROPIC_API_KEY: "sk-injected" },
      spec: CONFORMANCE_SPEC,
    });

    await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    const createArgv = calls[0];
    expect(createArgv).toContain("--env");
    expect(createArgv).toContain("ANTHROPIC_API_KEY=sk-injected");
    // Every OTHER credential var must be explicitly blanked, not omitted —
    // an omitted var is inherited from the tmux server.
    for (const key of PROVIDER_CREDENTIAL_VARS) {
      if (key === "ANTHROPIC_API_KEY") continue;
      expect(createArgv).toContain(`${key}=`);
    }
    // Exactly one --env per PROVIDER_CREDENTIAL_VARS entry.
    const envFlagCount = createArgv.filter((a) => a === "--env").length;
    expect(envFlagCount).toBe(PROVIDER_CREDENTIAL_VARS.length);
  });

  it("surfaces a non-zero exit as an error event when the transcript shows no new activity", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") return { code: 0, stdout: "", stderr: "" };
        if (argv[0] === "message") return { code: 1, stdout: "", stderr: "mngr: host unreachable" };
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
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

  it("does NOT surface a non-zero exit as an error when the transcript proves delivery", async () => {
    // Reproduces the observed mngr behaviour: `mngr message` times out and
    // exits non-zero, but the transcript shows the turn was answered.
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    let transcriptCalls = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") {
          transcriptCalls += 1;
          // Before the send: empty. After the send: one new assistant reply.
          const stdout =
            transcriptCalls === 1
              ? ""
              : `${JSON.stringify({ type: "user_message", role: "user", content: "hello" })}\n${JSON.stringify(
                  { type: "assistant_message", role: "assistant", text: "pong" },
                )}\n`;
          return { code: 0, stdout, stderr: "" };
        }
        if (argv[0] === "message") {
          return { code: 1, stdout: "", stderr: "Timeout waiting for message submission signal" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const events: AgentEvent[] = [];
    const ref = await backend.send(
      { agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" },
      "hello",
      (e) => events.push(e),
    );

    expect(events.at(-1)?.type).toBe("result");
    expect((events.at(-1) as { result: string }).result).toBe("pong");
    expect(ref.nativeId).toBe("agent-x");
  });

  it("transcript maps mngr jsonl events to TranscriptMessage, skipping unrecognised types", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    const lines = [
      JSON.stringify({ type: "user_message", role: "user", content: "hi", timestamp: "t1" }),
      JSON.stringify({
        type: "assistant_message",
        role: "assistant",
        text: "hello there",
        tool_calls: [],
        parts: [],
        finish_reason: "stop_sequence",
        usage: {},
      }),
      JSON.stringify({ type: "some_future_event", weird: true }),
    ].join("\n");
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") return { code: 0, stdout: lines, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const t = await backend.transcript({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" });

    expect(t).toEqual([
      { kind: "user", text: "hi" },
      { kind: "text", text: "hello there" },
    ]);
  });

  it("transcript returns null when there is no nativeId", async () => {
    const registry = makeRegistry();
    const backend = createMngrBackend({
      exec: recordingExec([]),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const t = await backend.transcript({ agentId: "x", nativeId: null, backend: "mngr" });
    expect(t).toBeNull();
  });

  it("stop marks the principal stopped in the registry and removes it from list()", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    const backend = createMngrBackend({
      exec: recordingExec([]),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    await backend.stop({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" });

    expect(registry.get(rec.agentId)?.status).toBe("stopped");
    const listed = await backend.list();
    expect(listed.some((r) => r.agentId === rec.agentId)).toBe(false);
  });

  it("two ensure() calls for the same agentId yield at most one list() entry", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv.includes("list")) {
          return { code: 0, stdout: JSON.stringify({ agents: [{ id: "agent-once" }] }), stderr: "" };
        }
        return { code: 0, stdout: "agent-once", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    await backend.ensure(rec.agentId, CONFORMANCE_SPEC);
    await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    const listed = await backend.list();
    expect(listed.filter((r) => r.agentId === rec.agentId)).toHaveLength(1);
  });
});

// The same contract the sdk backend satisfies.
runBackendConformance(
  "mngr",
  () => {
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
    });
  },
  () => {
    const registry = createAgentRegistry({
      indexPath: join(mkdtempSync(join(tmpdir(), "rhumb-conf-fail-")), "agents.json"),
      now: () => "2026-08-03T00:00:00.000Z",
      id: () => "rhumb-conf-fail",
    });
    return createMngrBackend({
      exec: async () => ({ code: 1, stdout: "", stderr: "mngr: unavailable" }),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });
  },
);
