import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createMngrBackend } from "../src/backends/mngr.js";
import { createRealExec } from "../src/backends/exec.js";
import { createAgentRegistry, type AgentRegistry } from "../src/agents.js";
import { SessionManager } from "../src/sessionManager.js";
// `createMngrAgentIdResolver` is exported from `../src/index.js` specifically so
// tests can drive the SAME resolver/release wiring `buildApp` uses (see
// test/index-agentid.test.ts) without importing the whole server. Importing it
// here has no side effects — `main()` only runs when index.ts is executed
// directly (see the `process.argv[1] === fileURLToPath(...)` guard at the
// bottom of index.ts).
import { createMngrAgentIdResolver } from "../src/index.js";
import type { AgentEvent } from "../src/types.js";
import type { AgentBackend } from "../src/backends/types.js";

const has = (bin: string) => spawnSync("command", ["-v", bin], { shell: true }).status === 0;
const available = has("mngr") && has("tmux") && has("git");

/** Real `mngr list --format json` parsed. Distinct from mngr.ts's own
 *  internal `listAgents` — this is the test's independent verification
 *  channel, deliberately not sharing code with the backend under test. */
function listMngrAgents(): Array<Record<string, unknown>> {
  const out = execFileSync("mngr", ["list", "--format", "json"], { encoding: "utf8" });
  const parsed = JSON.parse(out) as { agents?: Array<Record<string, unknown>> };
  return parsed.agents ?? [];
}

/** Best-effort agent teardown. Tolerates "already gone" — a test that fails
 *  partway through may already have destroyed its own agent, and `destroy`
 *  itself may warn (but still succeed) once the tmux server backing an
 *  agent's session has been killed (the ambient-credential test kills it
 *  deliberately, see below). `-b` also deletes the `mngr/<name>` branch —
 *  without it, Phase 0 documented that recreating an agent under the same
 *  name later fails with "branch already exists". */
function destroyMngrAgent(name: string): void {
  try {
    execFileSync("mngr", ["destroy", name, "--force", "-b"], { stdio: "pipe" });
  } catch (e) {
    // Surfaced to the test runner's stderr, not thrown — a cleanup failure
    // should not fail an otherwise-passing test, but must not be silent
    // either, since it means a real mngr agent/worktree/branch was left
    // behind and needs manual cleanup.
    console.error(`[live-test cleanup] failed to destroy mngr agent "${name}":`, e);
  }
}

/** Finds the pid of the actual `claude` CLI process mngr spawned for
 *  `nativeId`, by reading the UUID mngr itself embedded in `list --format
 *  json`'s `command` field for that agent (verified against 0.2.17 in
 *  docs/dogfood/2026-08-03-mngr-phase0.md's Q1 probe: `create`'s numeric
 *  agent id, re-hyphenated as a UUID, is exactly the `--session-id`/
 *  `--resume` argument the wrapper script launches `claude` with) and then
 *  locating the live process whose argv contains that UUID.
 *
 *  Deliberately reads mngr's OWN stated `command` rather than re-deriving
 *  the UUID from `nativeId` ourselves (a plausible-looking but unverified
 *  shortcut) — this way the test only depends on mngr's documented output
 *  shape, not on an assumption about its internal id scheme continuing to
 *  hold. */
function findClaudePidForAgent(nativeId: string): number | null {
  const agents = listMngrAgents();
  const agent = agents.find((a) => a.id === nativeId);
  const command = typeof agent?.command === "string" ? agent.command : undefined;
  const uuidMatch = command?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  if (!uuidMatch) return null;
  const uuid = uuidMatch[0];
  let pgrepOut: string;
  try {
    pgrepOut = execFileSync("pgrep", ["-f", uuid], { encoding: "utf8" });
  } catch {
    return null; // pgrep exits 1 when nothing matches
  }
  const pids = pgrepOut
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  for (const pid of pids) {
    try {
      // Several processes can carry the UUID in argv (the claude process
      // itself is the one that matters; be defensive about ordering).
      const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
      if (cmd.startsWith("claude")) return pid;
    } catch {
      // Process may have raced and already exited between pgrep and ps.
    }
  }
  return null;
}

async function waitForClaudePid(nativeId: string, timeoutMs = 30_000): Promise<number> {
  const start = Date.now();
  for (;;) {
    const pid = findClaudePidForAgent(nativeId);
    if (pid) return pid;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`no running claude process found for mngr agent ${nativeId} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Reads one environment variable from a live process's ACTUAL environment
 *  — not what argvCreate asked for, what the OS actually gave the process.
 *  `ps eww <pid>` (macOS/BSD `ps`) appends `KEY=VALUE ...` after the
 *  command; this is the exact technique Phase 0 used
 *  (docs/dogfood/2026-08-03-mngr-phase0.md, Q2) because it is the only way
 *  to observe what the tmux server actually handed the child, as opposed to
 *  what the `mngr create` argv merely requested. Returns `undefined` when
 *  the variable is entirely absent from the environment (distinct from an
 *  explicit empty assignment, which returns `""`). */
function getEnvVarFromPid(pid: number, name: string): string | undefined {
  const out = execFileSync("ps", ["eww", String(pid)], { encoding: "utf8" });
  const match = out.match(new RegExp(`(?:^|\\s)${name}=(\\S*)`));
  return match ? match[1] : undefined;
}

function rawEnvDumpForPid(pid: number): string {
  return execFileSync("ps", ["eww", String(pid)], { encoding: "utf8" });
}

describe.skipIf(!available)("mngr backend (live, localhost)", () => {
  // mngr's `create` resolves its SOURCE repo from the invoking process's
  // CURRENT WORKING DIRECTORY (argvCreate in mngr.ts passes no explicit
  // source path, and createRealExec's execFile call passes no `cwd` — it
  // inherits process.cwd()). AgentSpec.workspace is NOT consulted for this
  // at all. To keep every `mngr create` in this suite forking from a
  // disposable temp repo — never from the Rhumb checkout this test file
  // lives in — the whole test-worker process is chdir'd into a fresh temp
  // git repo for the duration of the suite. (Verified this works under
  // vitest's default `forks` pool, per vitest.config.ts; `process.chdir`
  // throws unconditionally under the `threads` pool, which this repo does
  // not use.)
  // `repoDir` is the git repo `mngr create` forks from (via cwd, see above)
  // — it MUST stay exactly as committed, or `mngr create` refuses with
  // "Working tree has uncommitted changes". `stateDir` is a SEPARATE
  // directory (a sibling, not a subdirectory of `repoDir`) for this test's
  // own bookkeeping — the AgentRegistry index files — so writing them can
  // never dirty the repo mngr is about to fork. (This bit us once while
  // developing this test: pointing the registry's indexPath inside
  // `repoDir` made every `mngr create` fail on an untracked
  // `agents-*.json`.)
  let repoDir: string;
  let stateDir: string;
  let originalCwd: string;
  const createdAgentNames: string[] = [];

  beforeAll(() => {
    originalCwd = process.cwd();
    const base = mkdtempSync(join(tmpdir(), "rhumb-live-"));
    repoDir = join(base, "repo");
    stateDir = join(base, "state");
    mkdirSync(repoDir);
    mkdirSync(stateDir);
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "rhumb-live-test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "rhumb-live-test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "Disposable workspace for agent-host's live mngr integration test.\n");
    // Phase 0: `mngr create` refuses to run when a path is ignored ONLY by
    // the user's global gitignore (it warns remote provisioning would
    // fail). `.claude/` must be ignored by the REPO's own .gitignore.
    writeFileSync(join(repoDir, ".gitignore"), ".claude/\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
    process.chdir(repoDir);
  });

  afterAll(() => {
    for (const name of createdAgentNames.reverse()) destroyMngrAgent(name);
    process.chdir(originalCwd);
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeRegistry(indexFile: string): AgentRegistry {
    return createAgentRegistry({
      indexPath: join(stateDir, indexFile),
      now: () => new Date().toISOString(),
      id: () => `rhumb-live-${randomUUID()}`,
    });
  }

  function makeBackend(
    registry: AgentRegistry,
    credentialEnv: Record<string, string>,
    extraBlankedVars?: readonly string[],
  ): AgentBackend {
    return createMngrBackend({
      exec: createRealExec(),
      registry,
      credentialEnv,
      spec: { model: "claude-opus-4-8", workspace: repoDir, permissionMode: "acceptEdits", extraOptions: {} },
      extraBlankedVars,
    });
  }

  /** Mirrors exactly the resolver/release wiring `buildApp` (src/index.ts)
   *  builds for `RHUMB_AGENT_BACKEND=mngr` — a fresh in-flight Set shared
   *  between the resolver and the release callback, per
   *  createMngrAgentIdResolver's doc comment (fix round 4, B2). This is
   *  what makes `SessionManager.run` here exercise the SAME code path
   *  `server.ts` drives in production, not a shortcut around it. */
  function makeSessionManager(registry: AgentRegistry, backend: AgentBackend): SessionManager {
    const inFlight = new Set<string>();
    return new SessionManager({
      backend,
      resolveAgentId: createMngrAgentIdResolver(registry, { inFlight }),
      releaseAgentId: (agentId) => inFlight.delete(agentId),
      model: "claude-opus-4-8",
      workspace: repoDir,
      permissionMode: "acceptEdits",
      extraOptions: {},
    });
  }

  // Shared across the three tests below — they intentionally build on each
  // other in order (spawn -> adopt -> stop), the same lifecycle a real
  // principal goes through, rather than three independent fixtures. Vitest
  // runs `it`s within one `describe` sequentially by default.
  let registry: AgentRegistry;
  let manager: SessionManager;
  let backend: AgentBackend;
  let boundAgentId: string;
  let boundNativeId: string;

  it(
    "a turn through SessionManager spawns a real mngr agent and binds its nativeId via the rhumb_agent_id label",
    { timeout: 240_000 },
    async () => {
      registry = makeRegistry("agents-turn.json");
      // A deliberately fake credential: this test proves the SPAWN/BIND
      // mechanism, not model behavior, so it never depends on (or spends)
      // a real credential. The CLI reaches a live prompt and answers with
      // an auth error, which is itself a real `assistant_message` in the
      // transcript — enough to prove delivery end-to-end. The separate
      // CLAUDE_CODE_OAUTH_TOKEN-gated test below covers an actual model
      // reply.
      backend = makeBackend(registry, { CLAUDE_CODE_OAUTH_TOKEN: "rhumb-live-test-fixture-token" });
      manager = makeSessionManager(registry, backend);

      const events: AgentEvent[] = [];
      const nativeId = await manager.run("Reply with exactly the word: pong", undefined, (e) => events.push(e));

      expect(nativeId).toBeTruthy();
      const last = events.at(-1);
      expect(last?.type === "result" || last?.type === "error").toBe(true);

      const records = registry.list();
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.backend).toBe("mngr");
      expect(record.nativeId).toBe(nativeId);
      createdAgentNames.push(record.name);
      boundAgentId = record.agentId;
      boundNativeId = nativeId;

      // Live proof of label-keyed adoption: the mngr agent's OWN listing
      // carries the Rhumb principal id in `labels.rhumb_agent_id`, and the
      // registry's binding is exactly that agent's `id`.
      const liveAgents = listMngrAgents();
      const match = liveAgents.find((a) => a.id === nativeId);
      expect(match, `expected mngr list to contain agent ${nativeId}`).toBeDefined();
      expect((match?.labels as Record<string, unknown> | undefined)?.rhumb_agent_id).toBe(boundAgentId);
    },
  );

  it(
    "a second turn for the same principal adopts the same mngr agent instead of creating a new one",
    { timeout: 240_000 },
    async () => {
      expect(boundNativeId, "previous test must have bound an agent").toBeTruthy();

      const events: AgentEvent[] = [];
      // The client resumes a conversation by handing back the sessionId
      // (== nativeId) it was given on the previous turn — exactly the wire
      // contract server.ts implements.
      const nativeId2 = await manager.run("Reply with exactly the word: still-pong", boundNativeId, (e) =>
        events.push(e),
      );

      expect(nativeId2).toBe(boundNativeId);
      // No second principal was minted.
      expect(registry.list()).toHaveLength(1);

      // The live proof: exactly ONE mngr agent still carries this
      // principal's label, and it's the SAME agent id as before.
      const liveAgents = listMngrAgents();
      const matches = liveAgents.filter(
        (a) => (a.labels as Record<string, unknown> | undefined)?.rhumb_agent_id === boundAgentId,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe(boundNativeId);
    },
  );

  it("stop() succeeds and marks the principal stopped in the registry", { timeout: 60_000 }, async () => {
    expect(boundNativeId, "previous tests must have bound an agent").toBeTruthy();
    // SessionManager has no `stop` — that lifecycle operation lives on
    // AgentBackend directly (slice 1 has no HTTP route for it yet; see the
    // brief's "Follow-ups" section). Calling the backend directly here is
    // deliberate and is the ONLY direct-backend call among the
    // spawn/adopt/stop trio — noted per the dispatch's instruction to flag
    // any assertion that can't go through SessionManager.
    await backend.stop({ agentId: boundAgentId, nativeId: boundNativeId, backend: "mngr" });
    expect(registry.get(boundAgentId)?.status).toBe("stopped");
  });

  // Skips rather than returning early: a test that asserts nothing is worse
  // than one that honestly reports as skipped. On this machine there is no
  // CLAUDE_CODE_OAUTH_TOKEN (the operator's claude.ai login lives in the
  // macOS keychain, unreachable from a tmux-spawned process — see
  // docs/dogfood/2026-08-03-mngr-phase0.md's Q1 caveat) so this reports
  // "skipped", not "passed" or "failed".
  it.skipIf(!process.env.CLAUDE_CODE_OAUTH_TOKEN)(
    "with a real credential, a turn returns an actual model reply",
    { timeout: 240_000 },
    async () => {
      const token = process.env.CLAUDE_CODE_OAUTH_TOKEN as string;
      const realRegistry = makeRegistry("agents-real-token.json");
      const realBackend = makeBackend(realRegistry, { CLAUDE_CODE_OAUTH_TOKEN: token });
      const realManager = makeSessionManager(realRegistry, realBackend);

      const events: AgentEvent[] = [];
      await realManager.run("Reply with exactly the word: pong", undefined, (e) => events.push(e));

      const record = realRegistry.list()[0];
      if (record) createdAgentNames.push(record.name);

      const last = events.at(-1);
      expect(last?.type).toBe("result");
      expect((last as { result: string }).result.toLowerCase()).toContain("pong");
    },
  );

  // Phase 0 Q2, made permanent and taken all the way to the OS: an ambient
  // credential must never reach the spawned agent's ACTUAL process
  // environment, and an explicitly-injected one must. This is the most
  // valuable test in this suite — everything else proves the mechanism
  // works; this proves the specific security property it exists for.
  it(
    "does not leak an ambient credential into a real spawned mngr agent's process environment",
    { timeout: 120_000 },
    async () => {
      const decoyVars = {
        ANTHROPIC_API_KEY: "sk-decoy-must-not-survive",
        ANTHROPIC_BASE_URL: "https://decoy-redirect.invalid",
        RHUMB_DECOY_SECRET: "decoy-secret-value",
      };
      const saved: Record<string, string | undefined> = {};
      for (const key of Object.keys(decoyVars)) saved[key] = process.env[key];
      Object.assign(process.env, decoyVars);

      try {
        // MANDATORY, not optional: kill the tmux server before spawning.
        // Phase 0 documents that skipping this produces a FALSE NEGATIVE —
        // a mngr agent's environment comes from whatever the tmux SERVER
        // was started with, not from the env of the `mngr` process that
        // requests the agent. If a server from an earlier command in this
        // suite (or an earlier shell) is still running, it predates these
        // decoy exports, so they would appear absent from the spawned
        // agent NOT because argvCreate's `--env` scrub worked, but because
        // the decoys never reached the server to begin with — a test that
        // would pass while proving nothing. Only killing the server (so
        // `mngr create` below starts a FRESH one under the current,
        // decoy-laden environment) makes an absent decoy meaningful
        // evidence that the scrub actually did something.
        try {
          execFileSync("tmux", ["kill-server"], { stdio: "ignore" });
        } catch {
          // "no server running on ..." exits non-zero; that's fine, there
          // was nothing to kill.
        }

        const decoyRegistry = makeRegistry("agents-decoy.json");
        // extraBlankedVars mirrors EXACTLY what src/index.ts computes in
        // production: the RHUMB_* keys of this process's OWN env at the
        // moment the backend is built. Computed AFTER the decoys are set
        // above, so RHUMB_DECOY_SECRET is included here precisely the way
        // a real ambient RHUMB_* var would be — this is what makes the
        // test exercise the FULL three-list guarantee
        // (PROVIDER_CREDENTIAL_VARS + STRIPPED_ENV_VARS + extraBlankedVars),
        // not just the two static lists.
        const extraBlankedVars = Object.keys(process.env).filter((k) => k.startsWith("RHUMB_"));
        const decoyBackend = makeBackend(
          decoyRegistry,
          { CLAUDE_CODE_OAUTH_TOKEN: "tok-injected-for-decoy-test" },
          extraBlankedVars,
        );

        const rec = decoyRegistry.create(`rhumb-decoy-live-${randomUUID().slice(0, 8)}`, "mngr");
        // Direct backend.ensure() call, not routed through SessionManager —
        // noted per the dispatch's instruction. This test is about what
        // argvCreate/credentialEnvFlags bake into `mngr create`'s argv at
        // CREATE time; no message needs to be sent to observe that, and
        // ensure() is where `create` happens. (SessionManager.run would
        // work equally well here but would also send a message, adding a
        // ~90s CLI round-trip — documented below and in the other tests —
        // that this assertion doesn't need.)
        const ref = await decoyBackend.ensure(rec.agentId, {
          model: "m",
          workspace: repoDir,
          permissionMode: "acceptEdits",
          extraOptions: {},
        });
        expect(ref.nativeId, "ensure() must have created and bound a live mngr agent").toBeTruthy();
        const nativeId = ref.nativeId as string;
        createdAgentNames.push(rec.name);

        const pid = await waitForClaudePid(nativeId);
        const rawDump = rawEnvDumpForPid(pid);

        // Inclusion: the explicitly-injected credential DOES arrive.
        expect(getEnvVarFromPid(pid, "CLAUDE_CODE_OAUTH_TOKEN")).toBe("tok-injected-for-decoy-test");

        // Exclusion: none of the decoy VALUES appear anywhere in the
        // process's real environment — not just under the name we planted
        // them as.
        for (const value of Object.values(decoyVars)) {
          expect(rawDump).not.toContain(value);
        }

        // Precise exclusion: PROVIDER_CREDENTIAL_VARS entries not supplied
        // via credentialEnv, and every STRIPPED_ENV_VARS / extraBlankedVars
        // entry, are blanked to an EMPTY string by credentialEnvFlags — not
        // merely "some other value". ANTHROPIC_API_KEY and
        // ANTHROPIC_BASE_URL are PROVIDER_CREDENTIAL_VARS; RHUMB_DECOY_SECRET
        // is only blanked because it was passed via extraBlankedVars above.
        expect(getEnvVarFromPid(pid, "ANTHROPIC_API_KEY")).toBe("");
        expect(getEnvVarFromPid(pid, "ANTHROPIC_BASE_URL")).toBe("");
        expect(getEnvVarFromPid(pid, "RHUMB_DECOY_SECRET")).toBe("");
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );
});
