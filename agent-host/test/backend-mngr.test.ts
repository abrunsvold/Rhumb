import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createMngrBackend,
  isTerminalFinishReason,
  TERMINAL_FINISH_REASONS,
  EMPTY_COMPLETION_RESULT,
  type ExecFn,
} from "../src/backends/mngr.js";
import { createAgentRegistry } from "../src/agents.js";
import { PROVIDER_CREDENTIAL_VARS } from "../src/provider.js";
import { STRIPPED_ENV_VARS } from "../src/env.js";
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

  it("ensure creates a mngr agent and resolves its nativeId via list, never trusting create's stdout (I2)", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    let created = false;
    const backend = createMngrBackend({
      exec: async (argv) => {
        calls.push(argv);
        if (argv[0] === "create") {
          created = true;
          // A stdout banner, per Phase 0's note that mngr stdout is "not
          // safe to parse without --format json" and create's stdout was
          // never separately characterised. Must NOT be parsed as the id.
          return { code: 0, stdout: "Docker provider disabled\nsome-banner-line\n", stderr: "" };
        }
        if (argv[0] === "list") {
          // Nothing carries the label until AFTER create runs (the
          // resolve-BEFORE-create step, added for N1, must not "find" an
          // agent that doesn't exist yet).
          return {
            code: 0,
            stdout: JSON.stringify({
              agents: created
                ? [{ id: "agent-resolved-via-list", labels: { rhumb_agent_id: rec.agentId } }]
                : [],
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBe("agent-resolved-via-list");
    expect(registry.get(rec.agentId)?.nativeId).toBe("agent-resolved-via-list");
    const createArgv = calls.find((c) => c[0] === "create");
    expect(createArgv?.slice(0, 5)).toEqual(["create", rec.name, "claude", "--no-connect", "-y"]);
  });

  it("create's argv includes --label rhumb_agent_id=<agentId> (A1)", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const backend = createMngrBackend({
      exec: recordingExec(calls, ""),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    const createArgv = calls.find((c) => c[0] === "create");
    if (!createArgv) throw new Error("expected a create call");
    const labelIndex = createArgv.indexOf("--label");
    expect(labelIndex).toBeGreaterThanOrEqual(0);
    // Labelled with the Rhumb PRINCIPAL (agentId), never the display name.
    expect(createArgv[labelIndex + 1]).toBe(`rhumb_agent_id=${rec.agentId}`);
  });

  it("resolve-before-create adopts a pre-existing agent by rhumb_agent_id label, not by name (A1)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    let createCalls = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "create") {
          createCalls += 1;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[0] === "list") {
          return {
            code: 0,
            // Deliberately a DIFFERENT name than `rec.name`, to prove
            // adoption is keyed on the label, not on name.
            stdout: JSON.stringify({
              agents: [
                { id: "agent-preexisting", name: "totally-different-name", labels: { rhumb_agent_id: rec.agentId } },
              ],
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBe("agent-preexisting");
    expect(createCalls).toBe(0);
    expect(registry.get(rec.agentId)?.nativeId).toBe("agent-preexisting");
  });

  it("does NOT adopt an agent with a matching name but no (or a different) rhumb_agent_id label (A1, fail-closed)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    let createCalls = 0;
    let created = false;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "create") {
          createCalls += 1;
          created = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[0] === "list") {
          const agents: Array<{ id: string; name?: string; labels?: Record<string, string> }> = [
            // Same NAME, but NO label at all -- e.g. a human ran
            // `mngr create probe claude` directly, or another tool made it.
            // Must NOT be adopted: it never went through the --env scrub.
            { id: "agent-human-created", name: rec.name },
            // Same NAME, but the WRONG rhumb_agent_id -- must not match either.
            { id: "agent-wrong-label", name: rec.name, labels: { rhumb_agent_id: "someone-elses-agentId" } },
          ];
          if (created) {
            agents.push({ id: "agent-correctly-labeled", name: rec.name, labels: { rhumb_agent_id: rec.agentId } });
          }
          return { code: 0, stdout: JSON.stringify({ agents }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    // Neither the label-less nor the wrong-label agent was adopted; instead
    // a genuinely new, correctly-labelled agent was created (proving
    // adoption is fail-closed, not fail-open on a name match).
    expect(ref.nativeId).toBe("agent-correctly-labeled");
    expect(createCalls).toBe(1);
  });

  it("two principals sharing a display name do not bind to the same nativeId (A1)", async () => {
    const registry = makeRegistry();
    const rec1 = registry.create("shared-name", "mngr");
    const rec2 = registry.create("shared-name", "mngr");
    const createdAgents: Array<{ id: string; labels: Record<string, string> }> = [];
    let counter = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "create") {
          const labelIndex = argv.indexOf("--label");
          const [, value] = argv[labelIndex + 1].split("=");
          const id = `agent-native-${++counter}`;
          createdAgents.push({ id, labels: { rhumb_agent_id: value } });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[0] === "list") {
          return { code: 0, stdout: JSON.stringify({ agents: createdAgents }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const ref1 = await backend.ensure(rec1.agentId, CONFORMANCE_SPEC);
    const ref2 = await backend.ensure(rec2.agentId, CONFORMANCE_SPEC);

    expect(ref1.nativeId).not.toBeNull();
    expect(ref2.nativeId).not.toBeNull();
    // The whole point: sharing `name` must not collapse the two principals
    // onto the same mngr agent.
    expect(ref1.nativeId).not.toBe(ref2.nativeId);
  });

  it("refuses to bind a nativeId already bound to a different, non-stopped principal (A1 belt-and-braces guard)", async () => {
    const registry = makeRegistry();
    const rec1 = registry.create("probe1", "mngr");
    const rec2 = registry.create("probe2", "mngr");
    registry.bind(rec1.agentId, "agent-shared");
    // Simulates a corrupted/colliding label: mngr reports the SAME native
    // agent id under rec2's label, even though rec1 already legitimately
    // owns it. Should never happen in practice -- this is the
    // belt-and-braces case, not the common path.
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "list") {
          return {
            code: 0,
            stdout: JSON.stringify({
              agents: [{ id: "agent-shared", name: "probe1", labels: { rhumb_agent_id: rec2.agentId } }],
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const ref = await backend.ensure(rec2.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBeNull();
    expect(registry.get(rec2.agentId)?.nativeId).toBeNull();
    // rec1's legitimate binding must be untouched.
    expect(registry.get(rec1.agentId)?.nativeId).toBe("agent-shared");

    const events: AgentEvent[] = [];
    await backend.send({ agentId: rec2.agentId, nativeId: null, backend: "mngr" }, "hi", (e) => events.push(e));
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect((last as { message: string }).message).toContain("already bound");
  });

  it("does not orphan a created agent when the immediately-following list is unknowable (N1)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    let createCalls = 0;
    // Simulates Phase 0's documented noisy Docker-provider transient
    // failure on `list`, right after a `create` that actually succeeded.
    let listShouldFail = true;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "create") {
          createCalls += 1;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[0] === "list") {
          if (listShouldFail) return { code: 1, stdout: "", stderr: "docker provider warning noise" };
          return {
            code: 0,
            stdout: JSON.stringify({ agents: [{ id: "agent-adopted", labels: { rhumb_agent_id: rec.agentId } }] }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    // First ensure(): resolve-before-create finds nothing (list fails, but
    // that's UNKNOWABLE not "not found", so create still runs), create
    // succeeds, and the immediately-following resolve is ALSO unknowable.
    // Must NOT be treated as a failed create.
    const first = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);
    expect(first.nativeId).toBeNull();
    // `reason` is an internal EnsureResult field, not part of the public
    // AgentRef contract -- cast to inspect it.
    expect((first as { reason?: string }).reason).toBe("create-unconfirmed");
    expect(createCalls).toBe(1);

    // The transient list failure clears, and list now reports the agent
    // create actually produced, correctly labelled.
    listShouldFail = false;

    // Second ensure(): must ADOPT the pre-existing agent via resolve-
    // before-create (keyed on the label, re-keyed for A1), not call create
    // again. Phase 0 documents that `create` fails once the branch
    // `mngr/<name>` already exists — retrying it here would permanently
    // orphan the agent instead of recovering it.
    const second = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);
    expect(second.nativeId).toBe("agent-adopted");
    expect(createCalls).toBe(1);
    expect(registry.get(rec.agentId)?.nativeId).toBe("agent-adopted");
  });

  it("treats a create whose new agent cannot be found in a trustworthy list as create-not-found, distinct from create-unconfirmed (I2/N1/A2)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "create") return { code: 0, stdout: "", stderr: "" };
        if (argv[0] === "list") {
          // No agent under this label shows up -- a genuinely KNOWN-ABSENT
          // result (well-formed JSON, just empty), not an unknowable one.
          return { code: 0, stdout: JSON.stringify({ agents: [] }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBeNull();
    expect((ref as { reason?: string }).reason).toBe("create-not-found");
    expect(registry.get(rec.agentId)?.nativeId).toBeNull();

    // A2: distinct from BOTH a genuine create failure AND the "unconfirmed"
    // (listing-was-unavailable) case -- this listing was perfectly
    // trustworthy and simply showed nothing, which is a different fact.
    const events: AgentEvent[] = [];
    await backend.send({ agentId: rec.agentId, nativeId: null, backend: "mngr" }, "hi", (e) => events.push(e));
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect((last as { message: string }).message).toContain("reported success but no agent");
    expect((last as { message: string }).message).not.toContain("could not be confirmed");
    expect((last as { message: string }).message).not.toContain("could not create an agent");
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
    let created = false;
    // `list --format json` reports a different agent under the "agents"
    // key before create, and additionally the freshly-created one after —
    // so the bound "agent-dead" is provably gone, and the new agent can be
    // resolved by its rhumb_agent_id label afterwards.
    const backend = createMngrBackend({
      exec: async (argv) => {
        calls.push(argv);
        if (argv[0] === "list") {
          const agents = created
            ? [{ id: "agent-someone-else" }, { id: "agent-reborn", labels: { rhumb_agent_id: rec.agentId } }]
            : [{ id: "agent-someone-else" }];
          return { code: 0, stdout: JSON.stringify({ agents }), stderr: "" };
        }
        if (argv[0] === "create") {
          created = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
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

  it("send() with nativeId: null re-creates a dead bound agent instead of erroring (fix round 4, B1)", async () => {
    // The test above proves ensureAgent's respawn logic is correct in
    // isolation. This one proves the ACTUAL entry point production code
    // uses — send(), not ensure() — actually reaches that logic. Before
    // fix round 4, SessionManager's mngr resolver could hand back a
    // non-null nativeId for a bound principal (round 3, A1's own fix), and
    // send() only calls ensureAgent when nativeId is falsy — so a bound
    // principal whose mngr agent died (box reboot, tmux kill) would skip
    // ensureAgent entirely and error against a dead id instead of
    // respawning. The resolver now always hands back nativeId: null (see
    // createMngrAgentIdResolver's doc comment in index.ts), which is what
    // this test simulates by calling send() with nativeId: null directly
    // even though the registry already has a (now-dead) bound nativeId.
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-dead");
    let created = false;
    let messageSent = false;
    const backend = createMngrBackend({
      exec: async (argv) => {
        calls.push(argv);
        if (argv[0] === "list") {
          const agents = created
            ? [{ id: "agent-reborn", labels: { rhumb_agent_id: rec.agentId } }]
            : [{ id: "agent-someone-else" }];
          return { code: 0, stdout: JSON.stringify({ agents }), stderr: "" };
        }
        if (argv[0] === "create") {
          created = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[0] === "transcript") {
          // Before the message is submitted the transcript is empty; after,
          // the reborn agent answers. C1's poll needs a real reply to find,
          // otherwise this test would (correctly) end in the honest
          // "delivered but not yet answered" outcome instead of a result.
          return messageSent
            ? {
                code: 0,
                stdout: `${JSON.stringify({ type: "assistant_message", role: "assistant", text: "reborn-pong", finish_reason: "stop_sequence" })}\n`,
                stderr: "",
              }
            : { code: 0, stdout: "", stderr: "" };
        }
        if (argv[0] === "message") {
          messageSent = true;
          return { code: 0, stdout: "ok", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const events: AgentEvent[] = [];
    const out = await backend.send(
      { agentId: rec.agentId, nativeId: null, backend: "mngr" },
      "hello",
      (e) => events.push(e),
    );

    expect(out.nativeId).toBe("agent-reborn");
    expect(registry.get(rec.agentId)?.nativeId).toBe("agent-reborn");
    expect(calls.some((c) => c.includes("create"))).toBe(true);
    expect(events.some((e) => e.type === "session" && e.sessionId === "agent-reborn")).toBe(true);
    const last = events.at(-1);
    expect(last?.type).toBe("result");
  });

  it("keeps the existing agent when liveness cannot be determined", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-existing");
    // A non-zero exit from `list` must NOT be read as "the agent is dead" —
    // liveness is unknowable, not false. (This short-circuits before JSON
    // parsing is ever attempted, since res.code !== 0 alone forces "unknown".)
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

  it("also treats a well-formed-JSON list without an agents array as unknown liveness", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-existing");
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv.includes("list")) {
          // A bare array, as an earlier draft of this backend assumed —
          // must NOT be read as "empty and therefore nothing is alive".
          return { code: 0, stdout: JSON.stringify([{ id: "agent-existing" }]), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBe("agent-existing");
  });

  it("ensure refuses to reuse or recreate for a principal marked stopped (I3a)", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    registry.markStopped(rec.agentId);
    const backend = createMngrBackend({
      exec: async (argv) => {
        calls.push(argv);
        // Even if mngr still lists the old agent as present (e.g. `mngr
        // stop` detaches without destroying), ensure() must not silently
        // reuse or replace it.
        if (argv[0] === "list") {
          return { code: 0, stdout: JSON.stringify({ agents: [{ id: "agent-x" }] }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBeNull();
    expect(calls.some((c) => c.includes("create"))).toBe(false);
    expect(registry.get(rec.agentId)?.nativeId).toBe("agent-x");
    expect(registry.get(rec.agentId)?.status).toBe("stopped");
  });

  it("send reports a distinct, accurate error when the principal is stopped (M3)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    registry.markStopped(rec.agentId);
    const backend = createMngrBackend({
      exec: recordingExec([]),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const events: AgentEvent[] = [];
    // A caller that (incorrectly) still has a nativeId-less ref for this
    // stopped principal falls through to ensureAgent inside send().
    await backend.send({ agentId: rec.agentId, nativeId: null, backend: "mngr" }, "hello", (e) =>
      events.push(e),
    );

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    // M3: must say WHY (stopped), not the generic "could not create" message
    // used for a genuine create failure -- neither is a create failure.
    expect((last as { message: string }).message).toContain("stopped");
    expect((last as { message: string }).message).not.toContain("could not create an agent");
  });

  it("send reports a distinct, accurate error for a flag-shaped agent name (M3)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("--env=ANTHROPIC_BASE_URL=https://attacker.example", "mngr");
    const backend = createMngrBackend({
      exec: recordingExec([]),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const events: AgentEvent[] = [];
    await backend.send({ agentId: rec.agentId, nativeId: null, backend: "mngr" }, "hello", (e) => events.push(e));

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect((last as { message: string }).message).toContain("not valid");
    expect((last as { message: string }).message).not.toContain("could not create an agent");
  });

  it("create blanks every PROVIDER_CREDENTIAL_VARS and STRIPPED_ENV_VARS entry not present in credentialEnv (I1)", async () => {
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

    // Note: calls[0] is now the resolve-BEFORE-create `list` lookup (N1),
    // not `create` itself -- find it explicitly rather than assuming index 0.
    const createArgv = calls.find((c) => c[0] === "create");
    if (!createArgv) throw new Error("expected a create call");
    expect(createArgv).toContain("--env");
    expect(createArgv).toContain("ANTHROPIC_API_KEY=sk-injected");
    // Every OTHER PROVIDER_CREDENTIAL_VARS entry must be explicitly blanked,
    // not omitted — an omitted var is inherited from the tmux server.
    for (const key of PROVIDER_CREDENTIAL_VARS) {
      if (key === "ANTHROPIC_API_KEY") continue;
      expect(createArgv).toContain(`${key}=`);
    }
    // Every STRIPPED_ENV_VARS entry must ALSO be blanked (I1): these are
    // not credentials, but an ambient value (e.g. CLAUDE_CODE_SHELL_PREFIX)
    // can rewrite or intercept every shell command the agent runs.
    for (const key of STRIPPED_ENV_VARS) {
      expect(createArgv).toContain(`${key}=`);
    }
    // Exactly one --env per variable across both lists — no more, no fewer.
    const envFlagCount = createArgv.filter((a) => a === "--env").length;
    expect(envFlagCount).toBe(PROVIDER_CREDENTIAL_VARS.length + STRIPPED_ENV_VARS.length);
  });

  it("omitting extraBlankedVars changes nothing (byte-identical to before the parameter existed)", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const backend = createMngrBackend({
      exec: recordingExec(calls, "agent-x"),
      registry,
      credentialEnv: { ANTHROPIC_API_KEY: "sk-injected" },
      spec: CONFORMANCE_SPEC,
      // extraBlankedVars deliberately omitted.
    });

    await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    const createArgv = calls.find((c) => c[0] === "create");
    if (!createArgv) throw new Error("expected a create call");
    const envFlagCount = createArgv.filter((a) => a === "--env").length;
    expect(envFlagCount).toBe(PROVIDER_CREDENTIAL_VARS.length + STRIPPED_ENV_VARS.length);
  });

  it("blanks an ambient RHUMB_* var passed via extraBlankedVars, without double-emitting overlaps (Task 5 F-close)", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const backend = createMngrBackend({
      exec: recordingExec(calls, "agent-x"),
      registry,
      credentialEnv: { ANTHROPIC_API_KEY: "sk-injected" },
      spec: CONFORMANCE_SPEC,
      // RHUMB_FOO is a genuine additional var; ANTHROPIC_API_KEY overlaps
      // PROVIDER_CREDENTIAL_VARS and must not produce a second --env.
      extraBlankedVars: ["RHUMB_FOO", "ANTHROPIC_API_KEY"],
    });

    await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    const createArgv = calls.find((c) => c[0] === "create");
    if (!createArgv) throw new Error("expected a create call");
    expect(createArgv).toContain("RHUMB_FOO=");
    // Blanked, not the injected credential value — RHUMB_FOO carries no
    // credential and must always be blanked.
    const flagPairs: [string, string][] = [];
    for (let i = 0; i < createArgv.length - 1; i++) {
      if (createArgv[i] === "--env") flagPairs.push(["--env", createArgv[i + 1]]);
    }
    expect(flagPairs.filter(([, v]) => v.startsWith("RHUMB_FOO="))).toHaveLength(1);
    // ANTHROPIC_API_KEY still appears exactly once, with the injected value
    // (not blanked) — the overlap must not add a duplicate blank entry.
    const apiKeyFlags = flagPairs.filter(([, v]) => v.startsWith("ANTHROPIC_API_KEY="));
    expect(apiKeyFlags).toHaveLength(1);
    expect(apiKeyFlags[0][1]).toBe("ANTHROPIC_API_KEY=sk-injected");
    // Total flag count grows by exactly one (RHUMB_FOO) over the base case.
    const envFlagCount = createArgv.filter((a) => a === "--env").length;
    expect(envFlagCount).toBe(PROVIDER_CREDENTIAL_VARS.length + STRIPPED_ENV_VARS.length + 1);
  });

  it("create carries model/permission-mode/allowedTools/disallowedTools/append-system-prompt after -- (I7a)", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const spec = {
      model: "claude-opus-4-8",
      workspace: "/ws",
      permissionMode: "acceptEdits",
      extraOptions: {
        allowedTools: ["Read", "mcp__ontology__query"],
        disallowedTools: ["AskUserQuestion"],
        systemPrompt: { type: "preset", preset: "claude_code", append: "operator approval required" },
      },
    };
    const backend = createMngrBackend({
      exec: recordingExec(calls),
      registry,
      credentialEnv: {},
      spec,
    });

    await backend.ensure(rec.agentId, spec);

    const createArgv = calls.find((c) => c[0] === "create");
    if (!createArgv) throw new Error("expected a create call");
    const sepIndex = createArgv.indexOf("--");
    expect(sepIndex).toBeGreaterThan(-1);
    // Every credential --env flag stays BEFORE the separator, untouched.
    expect(createArgv.slice(0, sepIndex).filter((a) => a === "--env")).toHaveLength(
      PROVIDER_CREDENTIAL_VARS.length + STRIPPED_ENV_VARS.length,
    );
    const agentArgs = createArgv.slice(sepIndex + 1);
    expect(agentArgs).toEqual([
      "--model",
      "claude-opus-4-8",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,mcp__ontology__query",
      "--disallowedTools",
      "AskUserQuestion",
      "--append-system-prompt",
      "operator approval required",
    ]);
  });

  it("create omits --allowedTools/--disallowedTools/--append-system-prompt when extraOptions doesn't carry them (I7a)", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const spec = { model: "m", workspace: "/ws", permissionMode: "plan", extraOptions: {} };
    const backend = createMngrBackend({ exec: recordingExec(calls), registry, credentialEnv: {}, spec });

    await backend.ensure(rec.agentId, spec);

    const createArgv = calls.find((c) => c[0] === "create");
    if (!createArgv) throw new Error("expected a create call");
    const agentArgs = createArgv.slice(createArgv.indexOf("--") + 1);
    expect(agentArgs).toEqual(["--model", "m", "--permission-mode", "plan"]);
  });

  it("warns (does NOT refuse) when spec.extraOptions.mcpServers is non-empty, naming the server (I7b, fix round 2)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = makeRegistry();
      let backend: ReturnType<typeof createMngrBackend> | undefined;
      expect(() => {
        backend = createMngrBackend({
          exec: recordingExec([]),
          registry,
          credentialEnv: {},
          spec: {
            model: "m",
            workspace: "/ws",
            permissionMode: "acceptEdits",
            extraOptions: { mcpServers: { ontology: {} } },
          },
        });
      }).not.toThrow();
      expect(backend).toBeDefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("[rhumb]");
      expect(message).toContain("ontology");
      expect(message).toMatch(/mcp/i);
      // Fix round 2's corrected framing: a capability reduction, not a gate
      // bypass — the warning must not still claim "ungated".
      expect(message).not.toMatch(/\bungated\b/i);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns (does NOT refuse) when spec.extraOptions.canUseTool is present, framed as unreachable tools not a bypassed gate (I7b, fix round 2)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = makeRegistry();
      let backend: ReturnType<typeof createMngrBackend> | undefined;
      expect(() => {
        backend = createMngrBackend({
          exec: recordingExec([]),
          registry,
          credentialEnv: {},
          spec: {
            model: "m",
            workspace: "/ws",
            permissionMode: "acceptEdits",
            extraOptions: { canUseTool: async () => ({ behavior: "allow" }) },
          },
        });
      }).not.toThrow();
      expect(backend).toBeDefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("[rhumb]");
      expect(message).toMatch(/canUseTool/);
      // The whole point of the fix round 2 correction: gated infra
      // operations are UNREACHABLE from a mngr agent, not merely ungated —
      // the message must draw that distinction explicitly, not just avoid
      // the word "ungated" (it may legitimately use it to contrast against).
      expect(message).toMatch(/unreachable/i);
      expect(message).toMatch(/not merely ungated/i);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn when mcpServers is present but empty and canUseTool is absent (I7b)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = makeRegistry();
      expect(() =>
        createMngrBackend({
          exec: recordingExec([]),
          registry,
          credentialEnv: {},
          spec: { model: "m", workspace: "/ws", permissionMode: "acceptEdits", extraOptions: { mcpServers: {} } },
        }),
      ).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns exactly once at construction even though ensure/send run multiple turns (I7b)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = makeRegistry();
      const rec = registry.create("probe", "mngr");
      const backend = createMngrBackend({
        exec: async (argv) => {
          if (argv[0] === "list") {
            return { code: 0, stdout: JSON.stringify({ agents: [{ id: "agent-x", labels: { rhumb_agent_id: rec.agentId } }] }), stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        registry,
        credentialEnv: {},
        spec: {
          model: "m",
          workspace: "/ws",
          permissionMode: "acceptEdits",
          extraOptions: { mcpServers: { ontology: {} } },
        },
        replyTimeoutMs: 0,
      });
      warn.mockClear(); // construction itself already warned once; isolate what happens after
      await backend.ensure(rec.agentId, CONFORMANCE_SPEC);
      await backend.send({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" }, "hi", () => {});
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("create never passes credentialEnv via exec's opts.env (I1)", async () => {
    const seenOpts: Array<{ env?: Record<string, string> } | undefined> = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const backend = createMngrBackend({
      exec: async (argv, opts) => {
        seenOpts.push(opts);
        if (argv[0] === "create") return { code: 0, stdout: "", stderr: "" };
        if (argv[0] === "list") {
          return { code: 0, stdout: JSON.stringify({ agents: [{ id: "agent-x", labels: { rhumb_agent_id: rec.agentId } }] }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: { ANTHROPIC_API_KEY: "sk-should-not-leak-into-process-env" },
      spec: CONFORMANCE_SPEC,
    });

    await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(seenOpts.length).toBeGreaterThan(0);
    for (const opts of seenOpts) expect(opts).toBeUndefined();
  });

  it("send never passes credentialEnv via exec's opts.env (I1)", async () => {
    const seenOpts: Array<{ env?: Record<string, string> } | undefined> = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    const backend = createMngrBackend({
      exec: async (argv, opts) => {
        seenOpts.push(opts);
        if (argv[0] === "transcript") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "ok", stderr: "" };
      },
      registry,
      credentialEnv: { ANTHROPIC_API_KEY: "sk-should-not-leak-into-process-env" },
      spec: CONFORMANCE_SPEC,
      replyTimeoutMs: 0,
    });

    await backend.send({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" }, "hi", () => {});

    expect(seenOpts.length).toBeGreaterThan(0);
    for (const opts of seenOpts) expect(opts).toBeUndefined();
  });

  it("refuses to create with a flag-shaped agent name (I6)", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("--env=ANTHROPIC_BASE_URL=https://attacker.example", "mngr");
    const backend = createMngrBackend({
      exec: recordingExec(calls, "agent-x"),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const ref = await backend.ensure(rec.agentId, CONFORMANCE_SPEC);

    expect(ref.nativeId).toBeNull();
    expect(calls.some((c) => c.includes("create"))).toBe(false);
  });

  it("does not treat delivery as proven when the pre-send transcript read itself failed (C1)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    let transcriptCalls = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") {
          transcriptCalls += 1;
          if (transcriptCalls === 1) {
            // Transient failure reading the PRE-send transcript: whether
            // anything grew is now unknowable, not "started from zero".
            return { code: 1, stdout: "", stderr: "boom" };
          }
          // The post-send read succeeds and returns PRIOR history from an
          // earlier, unrelated turn — not a real answer to this message.
          return {
            code: 0,
            stdout: `${JSON.stringify({
              type: "assistant_message",
              role: "assistant",
              text: "stale reply from a previous turn",
              finish_reason: "stop_sequence",
            })}\n`,
            stderr: "",
          };
        }
        if (argv[0] === "message") {
          return { code: 1, stdout: "", stderr: "mngr: host unreachable" };
        }
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

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect((last as { message: string }).message).toContain("host unreachable");
    // Must never surface the previous turn's stale reply as this turn's answer.
    if (last?.type === "result") {
      expect((last as unknown as { result: string }).result).not.toContain("stale reply");
    }
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

  it("does NOT surface a non-zero exit as an error when the transcript proves delivery with an assistant reply", async () => {
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
          const stdout =
            transcriptCalls === 1
              ? ""
              : `${JSON.stringify({ type: "user_message", role: "user", content: "hello" })}\n${JSON.stringify(
                  { type: "assistant_message", role: "assistant", text: "pong", finish_reason: "stop_sequence" },
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

  it("does not echo the operator's own prompt as the result when delivered but not yet answered (C2)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    let transcriptCalls = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") {
          transcriptCalls += 1;
          if (transcriptCalls === 1) return { code: 0, stdout: "", stderr: "" };
          // Only the operator's own submitted prompt is visible so far — no
          // assistant reply has landed.
          return {
            code: 0,
            stdout: `${JSON.stringify({ type: "user_message", role: "user", content: "hello" })}\n`,
            stderr: "",
          };
        }
        if (argv[0] === "message") {
          return { code: 1, stdout: "", stderr: "Timeout waiting for message submission signal" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      // Delivery IS proven here, so send() now waits for the answer on this
      // path too (a non-zero `mngr message` exit is the NORMAL outcome
      // against real mngr, even for turns that were delivered and answered
      // in ~2s). No reply ever lands in this fixture, so go straight to the
      // timeout branch instead of making the test wait for it.
      replyTimeoutMs: 0,
    });

    const events: AgentEvent[] = [];
    await backend.send(
      { agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" },
      "hello",
      (e) => events.push(e),
    );

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "result") {
      expect((last as unknown as { result: string }).result).not.toBe("hello");
    }
  });

  it("touches the registry when delivery is proven but not yet answered (M4)", async () => {
    let nowValue = "2026-08-03T00:00:00.000Z";
    const registry = createAgentRegistry({
      indexPath: join(dir, "agents.json"),
      now: () => nowValue,
      id: () => "rhumb-touch",
    });
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    const boundAt = registry.get(rec.agentId)?.lastActiveAt;
    nowValue = "2026-08-03T01:00:00.000Z";

    let transcriptCalls = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") {
          transcriptCalls += 1;
          if (transcriptCalls === 1) return { code: 0, stdout: "", stderr: "" };
          // Delivered (grew by one user_message) but not yet answered.
          return {
            code: 0,
            stdout: `${JSON.stringify({ type: "user_message", role: "user", content: "hello" })}\n`,
            stderr: "",
          };
        }
        if (argv[0] === "message") {
          return { code: 1, stdout: "", stderr: "Timeout waiting for message submission signal" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      replyTimeoutMs: 0,
    });

    const events: AgentEvent[] = [];
    await backend.send({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" }, "hello", (e) =>
      events.push(e),
    );

    // Sanity: confirms this exercised the delivered-but-unanswered branch.
    expect(events.at(-1)?.type).toBe("error");
    // The actual M4 assertion: lastActiveAt was bumped, proving touch() ran
    // even though the turn was reported as an error, not a result.
    expect(registry.get(rec.agentId)?.lastActiveAt).not.toBe(boundAt);
    expect(registry.get(rec.agentId)?.lastActiveAt).toBe(nowValue);
  });

  it("does not echo the operator's prompt as the result on a successful exit with no assistant reply yet (C2, success path)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") {
          return {
            code: 0,
            stdout: `${JSON.stringify({ type: "user_message", role: "user", content: "hello" })}\n`,
            stderr: "",
          };
        }
        // `mngr message` exits 0 with a banner on stdout. Pre-C1 this
        // banner was emitted as `{ type: "result", isError: false }` —
        // mngr's own CLI chatter presented to the operator as the model's
        // reply. It must never appear in an event now.
        return { code: 0, stdout: "Docker provider disabled\nmessage submitted", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      // The poll finds no NEW assistant entry; go straight to the timeout
      // branch rather than making the test wait.
      replyTimeoutMs: 0,
    });

    const events: AgentEvent[] = [];
    await backend.send(
      { agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" },
      "hello",
      (e) => events.push(e),
    );

    const last = events.at(-1);
    // C1: no assistant reply ever landed, so the turn is NOT answered. The
    // honest "delivered but not yet answered" outcome — never a result.
    expect(last?.type).toBe("error");
    expect((last as { message: string }).message).toContain("not yet answered");
    // Neither the operator's own prompt nor mngr's stdout may surface as
    // the answer, on any event.
    for (const e of events) {
      if (e.type === "result") {
        expect((e as unknown as { result: string }).result).not.toBe("hello");
        expect((e as unknown as { result: string }).result).not.toContain("message submitted");
      }
    }
  });

  it("selects the newest ASSISTANT reply, not the last transcript entry of any kind (N2)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    let transcriptCalls = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") {
          transcriptCalls += 1;
          const priorTurn = [
            { type: "user_message", role: "user", content: "first question" },
            { type: "assistant_message", role: "assistant", text: "first answer", finish_reason: "stop_sequence" },
          ];
          const thisTurn = [
            ...priorTurn,
            { type: "user_message", role: "user", content: "hello" },
            { type: "assistant_message", role: "assistant", text: "second answer", finish_reason: "stop_sequence" },
          ];
          const lines = transcriptCalls === 1 ? priorTurn : thisTurn;
          return { code: 0, stdout: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", stderr: "" };
        }
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

    // A genuinely NEW assistant entry ("second answer") appeared after
    // `before`'s snapshot. The result must be that entry, never the last
    // entry of any kind ("hello", the operator's own prompt) and never the
    // PREVIOUS turn's reply ("first answer", which is also transcript-last
    // among assistant entries if growth-gating is forgotten).
    const last = events.at(-1);
    expect(last?.type).toBe("result");
    expect((last as { result: string }).result).toBe("second answer");
  });

  it("does not report a stale prior answer on a successful exit with no NEW assistant reply (N2)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    // Identical before AND after: `mngr message` returned 0, but the new
    // reply has not landed in the transcript by the time it's read — only
    // a PREVIOUS turn's answer is present.
    const staticTranscript = [
      { type: "user_message", role: "user", content: "first question" },
      { type: "assistant_message", role: "assistant", text: "first answer", finish_reason: "stop_sequence" },
    ];
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") {
          return {
            code: 0,
            stdout: staticTranscript.map((l) => JSON.stringify(l)).join("\n") + "\n",
            stderr: "",
          };
        }
        return { code: 0, stdout: "banner", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      replyTimeoutMs: 0,
    });

    const events: AgentEvent[] = [];
    await backend.send(
      { agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" },
      "hello",
      (e) => events.push(e),
    );

    const last = events.at(-1);
    // C1: the previous turn's reply is not this turn's answer, and mngr's
    // stdout is not an answer at all — so the turn ends honestly
    // unanswered rather than with either of them.
    expect(last?.type).toBe("error");
    expect((last as { message: string }).message).toContain("not yet answered");
    for (const e of events) {
      if (e.type === "result") {
        expect((e as unknown as { result: string }).result).not.toBe("first answer");
        expect((e as unknown as { result: string }).result).not.toBe("banner");
      }
    }
  });

  // --- C1: `mngr message` returns on SUBMISSION, not completion ---------

  it("polls the transcript after a successful submission and emits the reply that appears (C1)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    let transcriptCalls = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") {
          transcriptCalls += 1;
          // call 1 = the pre-send baseline (empty).
          // calls 2-4 = polls where only the operator's own submitted
          //             prompt is visible; Claude is still thinking.
          // call 5   = the reply finally lands.
          if (transcriptCalls === 1) return { code: 0, stdout: "", stderr: "" };
          const lines: unknown[] = [{ type: "user_message", role: "user", content: "hello" }];
          if (transcriptCalls >= 5) {
            lines.push({ type: "assistant_message", role: "assistant", text: "pong", finish_reason: "stop_sequence" });
          }
          return { code: 0, stdout: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", stderr: "" };
        }
        // A successful submission whose stdout is a banner, exactly as real
        // mngr behaves. It must never become the result.
        return { code: 0, stdout: "Docker provider disabled", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      replyTimeoutMs: 5_000,
      replyPollIntervalMs: 0,
    });

    const events: AgentEvent[] = [];
    await backend.send({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" }, "hello", (e) =>
      events.push(e),
    );

    // The turn waited across several polls rather than completing on the
    // first read (which, pre-C1, is exactly what returned mngr's banner).
    expect(transcriptCalls).toBeGreaterThanOrEqual(5);
    const last = events.at(-1);
    expect(last?.type).toBe("result");
    expect((last as { result: string }).result).toBe("pong");
  });

  it("reports the honest not-yet-answered outcome on timeout, never mngr's stdout (C1)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    let transcriptCalls = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") {
          transcriptCalls += 1;
          if (transcriptCalls === 1) return { code: 0, stdout: "", stderr: "" };
          // The prompt was submitted, but no assistant reply ever arrives.
          return {
            code: 0,
            stdout: `${JSON.stringify({ type: "user_message", role: "user", content: "hello" })}\n`,
            stderr: "",
          };
        }
        return { code: 0, stdout: "mngr-banner-must-not-be-the-answer", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      replyTimeoutMs: 20,
      replyPollIntervalMs: 0,
    });

    const events: AgentEvent[] = [];
    await backend.send({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" }, "hello", (e) =>
      events.push(e),
    );

    const last = events.at(-1);
    // Same honest shape the non-zero-exit branch already produced.
    expect(last?.type).toBe("error");
    expect((last as { message: string }).message).toContain("not yet answered");
    // The whole point of C1: mngr's CLI stdout is never the model's answer.
    expect(JSON.stringify(events)).not.toContain("mngr-banner-must-not-be-the-answer");
    expect(events.some((e) => e.type === "result")).toBe(false);
  });

  it("does not poll (and does not report a stale reply) when the pre-send transcript read failed (C1)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    let transcriptCalls = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") {
          transcriptCalls += 1;
          // The BASELINE read fails, so "new" can never be distinguished
          // from "already there" for the rest of this turn.
          if (transcriptCalls === 1) return { code: 1, stdout: "", stderr: "boom" };
          return {
            code: 0,
            stdout: `${JSON.stringify({
              type: "assistant_message",
              role: "assistant",
              text: "stale reply from a previous turn",
            })}\n`,
            stderr: "",
          };
        }
        return { code: 0, stdout: "banner", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      // Deliberately long: if the implementation polled here it would
      // either hang this test or surface the stale reply. It must instead
      // short-circuit immediately.
      replyTimeoutMs: 60_000,
      replyPollIntervalMs: 0,
    });

    const events: AgentEvent[] = [];
    await backend.send({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" }, "hello", (e) =>
      events.push(e),
    );

    expect(transcriptCalls).toBe(1);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect((last as { message: string }).message).toContain("not yet answered");
    expect(JSON.stringify(events)).not.toContain("stale reply");
  });

  it("treats mngr's 'no transcript events yet' error as an EMPTY baseline, not an unreadable one (C1, first turn)", async () => {
    // Observed live against mngr 0.2.17: on a brand-new agent's very first
    // turn the PRE-send `mngr transcript` exits 1 with this error, and
    // `mngr message` then exits 1 after 90s ("Timeout waiting for message
    // submission signal") on a prompt the transcript proves was delivered
    // and answered within ~2s. Reading that error as "unknowable" made the
    // first turn of EVERY mngr agent report a bare CLI error while the
    // model's real answer sat unread in the transcript.
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    let transcriptCalls = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") {
          transcriptCalls += 1;
          if (transcriptCalls === 1) {
            return {
              code: 1,
              stdout: JSON.stringify({
                event: "error",
                error_class: "MngrError",
                message:
                  "No common transcript found for agent 'probe'. The agent may not have produced any transcript events yet.",
              }),
              stderr: "Error: No common transcript found for agent 'probe'.",
            };
          }
          return {
            code: 0,
            stdout:
              [
                { type: "user_message", role: "user", content: "hello" },
                { type: "assistant_message", role: "assistant", text: "pong", finish_reason: "stop_sequence" },
              ]
                .map((l) => JSON.stringify(l))
                .join("\n") + "\n",
            stderr: "",
          };
        }
        return { code: 1, stdout: "", stderr: "Timeout waiting for message submission signal (waited 90.0s)" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      replyTimeoutMs: 0,
    });

    const events: AgentEvent[] = [];
    await backend.send({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" }, "hello", (e) =>
      events.push(e),
    );

    const last = events.at(-1);
    expect(last?.type).toBe("result");
    expect((last as { result: string }).result).toBe("pong");
  });

  it("still treats a genuinely unreadable transcript as unknowable, not empty (C1 guard)", async () => {
    // The narrowness of the mapping above is the point: any OTHER non-zero
    // transcript exit must still disable the new-vs-stale comparison, or
    // the stale-reply failure mode comes straight back.
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    let transcriptCalls = 0;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "transcript") {
          transcriptCalls += 1;
          if (transcriptCalls === 1) return { code: 1, stdout: "", stderr: "boom: host unreachable" };
          return {
            code: 0,
            stdout: `${JSON.stringify({
              type: "assistant_message",
              role: "assistant",
              text: "stale reply from a previous turn",
              finish_reason: "stop_sequence",
            })}\n`,
            stderr: "",
          };
        }
        return { code: 1, stdout: "", stderr: "mngr: host unreachable" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      replyTimeoutMs: 0,
    });

    const events: AgentEvent[] = [];
    await backend.send({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" }, "hello", (e) =>
      events.push(e),
    );

    expect(events.at(-1)?.type).toBe("error");
    expect(JSON.stringify(events)).not.toContain("stale reply");
  });

  // --- C2: the agent must operate on AgentSpec.workspace ----------------

  it("create points mngr at spec.workspace and runs there IN PLACE, not in a worktree of the cwd repo (C2)", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const spec = {
      model: "m",
      workspace: join(dir, "ws"),
      permissionMode: "acceptEdits",
      extraOptions: {},
    };
    const backend = createMngrBackend({
      exec: recordingExec(calls),
      registry,
      credentialEnv: {},
      spec,
    });

    await backend.ensure(rec.agentId, spec);

    const createArgv = calls.find((c) => c[0] === "create");
    if (!createArgv) throw new Error("expected a create call");
    const sepIndex = createArgv.indexOf("--");
    const beforeSep = sepIndex === -1 ? createArgv : createArgv.slice(0, sepIndex);

    // `--from :<PATH>` — the `:` prefix is mandatory: a bare name means
    // another mngr AGENT, not a directory.
    const fromIndex = beforeSep.indexOf("--from");
    expect(fromIndex).toBeGreaterThanOrEqual(0);
    expect(beforeSep[fromIndex + 1]).toBe(`:${join(dir, "ws")}`);
    // `--transfer none` = run in-place. Without it mngr's default for a git
    // source is `git-worktree`: the agent would get a COPY on a fresh
    // `mngr/<name>` branch and its writes to workspace/ would be invisible
    // to the host.
    const transferIndex = beforeSep.indexOf("--transfer");
    expect(transferIndex).toBeGreaterThanOrEqual(0);
    expect(beforeSep[transferIndex + 1]).toBe("none");
    // workspace/ is expected to be dirty (it is where agents write), and an
    // in-place run cuts no branch, so the default --ensure-clean must be off
    // or EVERY turn fails on an uncommitted file.
    expect(beforeSep).toContain("--no-ensure-clean");
  });

  it("resolves a relative workspace to an absolute path so it never depends on the host process's cwd (C2)", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const spec = { model: "m", workspace: "./workspace", permissionMode: "acceptEdits", extraOptions: {} };
    const backend = createMngrBackend({ exec: recordingExec(calls), registry, credentialEnv: {}, spec });

    await backend.ensure(rec.agentId, spec);

    const createArgv = calls.find((c) => c[0] === "create");
    if (!createArgv) throw new Error("expected a create call");
    const from = createArgv[createArgv.indexOf("--from") + 1];
    expect(from).toBe(`:${resolve("./workspace")}`);
    expect(from.startsWith(":/")).toBe(true);
  });

  it("refuses to construct with a blank workspace rather than silently running against the cwd (C2, fail closed)", () => {
    const registry = makeRegistry();
    expect(() =>
      createMngrBackend({
        exec: recordingExec([]),
        registry,
        credentialEnv: {},
        spec: { model: "m", workspace: "   ", permissionMode: "acceptEdits", extraOptions: {} },
      }),
    ).toThrow(/workspace/i);
  });

  // --- I4: Task 3's boolean returns are actually checked -----------------

  it("does not report a successful ensure when registry.bind fails (I4)", async () => {
    const registry = makeRegistry();
    // No record is ever created for this agentId — reachable through the
    // public interface, since ensure() accepts any agentId string.
    const orphanAgentId = "rhumb-never-registered";
    let createCalls = 0;
    let created = false;
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "create") {
          createCalls += 1;
          created = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[0] === "list") {
          return {
            code: 0,
            stdout: JSON.stringify({
              agents: created ? [{ id: "agent-orphan", labels: { rhumb_agent_id: orphanAgentId } }] : [],
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      replyTimeoutMs: 0,
    });

    const ref = await backend.ensure(orphanAgentId, CONFORMANCE_SPEC);

    // A real mngr agent WAS created, but nothing was persisted — so the ref
    // must not assert a binding that does not exist.
    expect(createCalls).toBe(1);
    expect(ref.nativeId).toBeNull();
    expect((ref as { reason?: string }).reason).toBe("bind-failed");
    expect(registry.get(orphanAgentId)).toBeUndefined();

    // And send() reports it as its own distinct refusal, not as a create
    // failure (create succeeded) nor as a silent success.
    const events: AgentEvent[] = [];
    await backend.send({ agentId: orphanAgentId, nativeId: null, backend: "mngr" }, "hi", (e) => events.push(e));
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect((last as { message: string }).message).toContain("could not be persisted");
    expect((last as { message: string }).message).not.toContain("could not create an agent");
  });

  it("warns instead of silently ignoring a failed registry.touch (I4)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = makeRegistry();
      const backend = createMngrBackend({
        exec: async (argv) => {
          if (argv[0] === "transcript") return { code: 0, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        registry,
        credentialEnv: {},
        spec: CONFORMANCE_SPEC,
        replyTimeoutMs: 0,
      });

      // A ref carrying a nativeId but an agentId the registry never knew:
      // send() skips ensureAgent entirely and goes straight to touch().
      await backend.send({ agentId: "rhumb-unknown", nativeId: "agent-x", backend: "mngr" }, "hi", () => {});

      expect(warn).toHaveBeenCalled();
      const message = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(message).toContain("[rhumb]");
      expect(message).toContain("rhumb-unknown");
    } finally {
      warn.mockRestore();
    }
  });

  it("throws rather than claim stopped when registry.markStopped fails (I4)", async () => {
    const registry = makeRegistry();
    const backend = createMngrBackend({
      exec: recordingExec([]),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    // Same posture as I3b (a failed `mngr stop` throws): stop() resolving
    // tells the caller the principal is retired, and it isn't.
    await expect(
      backend.stop({ agentId: "rhumb-unknown", nativeId: null, backend: "mngr" }),
    ).rejects.toThrow(/no such record/);
    await expect(
      backend.stop({ agentId: "rhumb-unknown", nativeId: "agent-x", backend: "mngr" }),
    ).rejects.toThrow(/no such record/);
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

  it("skips a transcript entry whose content/text is not a string, instead of coercing to empty text (minor)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    const lines = [
      JSON.stringify({ type: "user_message", role: "user", content: 42 }),
      JSON.stringify({ type: "assistant_message", role: "assistant", text: null }),
      JSON.stringify({ type: "user_message", role: "user", content: "real" }),
    ].join("\n");
    const backend = createMngrBackend({
      exec: async (argv) =>
        argv[0] === "transcript" ? { code: 0, stdout: lines, stderr: "" } : { code: 0, stdout: "", stderr: "" },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    const t = await backend.transcript({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" });
    expect(t).toEqual([{ kind: "user", text: "real" }]);
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

  it("stop does not mark the principal stopped when the mngr stop command fails (I3b)", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    const backend = createMngrBackend({
      exec: async () => ({ code: 1, stdout: "", stderr: "mngr: agent busy" }),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    await expect(
      backend.stop({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" }),
    ).rejects.toThrow(/agent busy/);

    expect(registry.get(rec.agentId)?.status).toBe("active");
    const listed = await backend.list();
    expect(listed.some((r) => r.agentId === rec.agentId)).toBe(true);
  });

  it("stop with no nativeId still marks the principal stopped without calling the CLI", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const backend = createMngrBackend({
      exec: recordingExec(calls),
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    await backend.stop({ agentId: rec.agentId, nativeId: null, backend: "mngr" });

    expect(registry.get(rec.agentId)?.status).toBe("stopped");
    expect(calls.some((c) => c.includes("stop"))).toBe(false);
  });

  it("two ensure() calls for the same agentId yield at most one list() entry", async () => {
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    const backend = createMngrBackend({
      exec: async (argv) => {
        if (argv[0] === "list") {
          return {
            code: 0,
            stdout: JSON.stringify({
              agents: [{ id: "agent-once", labels: { rhumb_agent_id: rec.agentId } }],
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
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

  it("uses the exact verified argv shape for message/transcript/stop (I5)", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    const backend = createMngrBackend({
      exec: async (argv) => {
        calls.push(argv);
        return { code: 0, stdout: "", stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      replyTimeoutMs: 0,
    });

    await backend.send({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" }, "hello world", () => {});
    await backend.transcript({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" });
    await backend.stop({ agentId: rec.agentId, nativeId: "agent-x", backend: "mngr" });

    const messageCalls = calls.filter((c) => c[0] === "message");
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]).toEqual(["message", "agent-x", "-m", "hello world"]);

    const transcriptCalls = calls.filter((c) => c[0] === "transcript");
    expect(transcriptCalls.length).toBeGreaterThan(0);
    for (const c of transcriptCalls) expect(c).toEqual(["transcript", "agent-x", "--format", "jsonl"]);

    const stopCalls = calls.filter((c) => c[0] === "stop");
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]).toEqual(["stop", "agent-x"]);
  });

  it("uses the exact verified argv shape for list (I5)", async () => {
    const calls: string[][] = [];
    const registry = makeRegistry();
    const rec = registry.create("probe", "mngr");
    registry.bind(rec.agentId, "agent-x");
    const backend = createMngrBackend({
      exec: async (argv) => {
        calls.push(argv);
        return { code: 0, stdout: JSON.stringify({ agents: [] }), stderr: "" };
      },
      registry,
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
    });

    await backend.list();

    const listCalls = calls.filter((c) => c[0] === "list");
    expect(listCalls.length).toBeGreaterThan(0);
    for (const c of listCalls) expect(c).toEqual(["list", "--format", "json"]);
  });
});

// The same contract the sdk backend satisfies. `makeBackend` seeds the
// registry with real records for every agentId the conformance suite calls
// ensure() with, and uses a stateful fake exec that actually implements
// create/list/message/transcript/stop consistently — an empty registry and
// an always-identical canned exec (the brief's original fixture) made the
// "no duplicates in list()" and "stop removes from list()" obligations pass
// vacuously against an always-empty list() (I4).
const CONFORMANCE_AGENT_IDS = [
  "agent-conf-1",
  "agent-conf-2",
  "agent-conf-3",
  "agent-conf-4",
  "agent-conf-5",
  "agent-conf-6",
];

function makeSeededConformanceRegistry(prefix: string) {
  let n = 0;
  const registry = createAgentRegistry({
    indexPath: join(mkdtempSync(join(tmpdir(), prefix)), "agents.json"),
    now: () => "2026-08-03T00:00:00.000Z",
    id: () => CONFORMANCE_AGENT_IDS[n++],
  });
  for (const id of CONFORMANCE_AGENT_IDS) registry.create(id, "mngr");
  return registry;
}

function makeConformanceExec(): ExecFn {
  const createdAgents: Array<{ id: string; name: string; labels: Record<string, string> }> = [];
  let counter = 0;
  return async (argv) => {
    if (argv[0] === "create") {
      const name = argv[1];
      // Adoption is keyed on the rhumb_agent_id label (A1), not on name —
      // parse it out of argv the way real mngr would round-trip it back.
      const labelIndex = argv.indexOf("--label");
      const [labelKey, labelValue] = labelIndex >= 0 ? argv[labelIndex + 1].split("=") : [undefined, undefined];
      const id = `agent-conf-native-${++counter}`;
      createdAgents.push({
        id,
        name,
        labels: labelKey && labelValue !== undefined ? { [labelKey]: labelValue } : {},
      });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (argv[0] === "list") {
      return { code: 0, stdout: JSON.stringify({ agents: createdAgents }), stderr: "" };
    }
    // message / transcript / stop: nothing to simulate, plain success.
    return { code: 0, stdout: "", stderr: "" };
  };
}

runBackendConformance(
  "mngr",
  () =>
    createMngrBackend({
      exec: makeConformanceExec(),
      registry: makeSeededConformanceRegistry("rhumb-conf-"),
      credentialEnv: {},
      spec: CONFORMANCE_SPEC,
      // The conformance fake never produces an assistant reply, so C1's
      // poll would otherwise run to its full production timeout. `0` keeps
      // the contract being checked (a terminal result-or-error event)
      // while reading the transcript exactly once, as before C1.
      replyTimeoutMs: 0,
    }),
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
      replyTimeoutMs: 0,
    });
  },
);

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

  // mngr passes Claude's own Messages API `stop_reason` through verbatim as
  // `finish_reason` (confirmed against mngr's source,
  // common_transcript_convert.py:154,217 — see TERMINAL_FINISH_REASONS's doc
  // comment). That value space includes `max_tokens` (a token-truncated
  // turn) as well as `stop_sequence`/`end_turn`, and `tool_use` (a segment
  // that ends in a tool call, i.e. the model is not done). A truncated
  // answer is still a FINISHED turn — treating it as non-terminal would
  // poll out the full reply timeout and then report "not yet answered"
  // while a real, if truncated, answer already sits in the transcript.
  it("treats max_tokens as terminal (a truncated answer is still a finished turn) and tool_use as non-terminal", () => {
    expect(isTerminalFinishReason("max_tokens")).toBe(true);
    expect(TERMINAL_FINISH_REASONS.has("max_tokens")).toBe(true);
    expect(isTerminalFinishReason("tool_use")).toBe(false);
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
    // Must be self-describing, not "" — and pinned to the exported constant
    // so the contract survives a wording change rather than a regex guess.
    expect(last.result).toBe(EMPTY_COMPLETION_RESULT);
    expect(last.result).not.toBe("");
  });

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
});
