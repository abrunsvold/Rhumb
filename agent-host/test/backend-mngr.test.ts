import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMngrBackend, type ExecFn } from "../src/backends/mngr.js";
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
    expect(last?.type).toBe("result");
    // Must fall back to `mngr message`'s own (empty) stdout, never to the
    // user_message transcript entry — otherwise the operator's own prompt
    // would come back as "the answer".
    expect((last as { result: string }).result).toBe("");
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
            { type: "assistant_message", role: "assistant", text: "first answer" },
          ];
          const thisTurn = [
            ...priorTurn,
            { type: "user_message", role: "user", content: "hello" },
            { type: "assistant_message", role: "assistant", text: "second answer" },
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
      { type: "assistant_message", role: "assistant", text: "first answer" },
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
    expect(last?.type).toBe("result");
    // Must NOT be "first answer" (the previous turn's reply, reported
    // stale as the answer to THIS "hello"). Falls back to mngr message's
    // own (empty) stdout instead.
    expect((last as { result: string }).result).toBe("");
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
    });
  },
);
