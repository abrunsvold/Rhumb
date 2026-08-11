import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createMngrBackend } from "../src/backends/mngr.js";
import { createRealExec } from "../src/backends/exec.js";
import { createAgentRegistry, type AgentRegistry } from "../src/agents.js";
import { createFleetOps } from "../src/fleet/ops.js";
import type { AgentStatus } from "../src/fleet/status.js";

const has = (bin: string) => spawnSync("command", ["-v", bin], { shell: true }).status === 0;

/** Opt-in exactly like test/backend-mngr.integration.test.ts's `available`
 *  guard (see its doc comment for the full rationale — the short version:
 *  this suite spawns real mngr agents and takes several minutes, so binary
 *  presence alone is not a safe trigger for `npm test`). With
 *  `RHUMB_LIVE_MNGR=1` unset the suite reports as skipped, not passed:
 *    RHUMB_LIVE_MNGR=1 PATH="$HOME/.local/bin:$PATH" npx vitest run test/fleet.integration.test.ts */
const optedIn = process.env.RHUMB_LIVE_MNGR === "1";
const available = optedIn && has("mngr") && has("tmux") && has("git");

const ALL_STATUSES: readonly AgentStatus[] = ["working", "done", "blocked", "stopped", "failed", "unknown"];

/** Real `mngr list --format json` parsed — the test's own independent
 *  verification channel, deliberately not sharing code with the backend
 *  under test (mirrors listMngrAgents in backend-mngr.integration.test.ts). */
function listMngrAgents(): Array<Record<string, unknown>> {
  const out = execFileSync("mngr", ["list", "--format", "json"], { encoding: "utf8" });
  const parsed = JSON.parse(out) as { agents?: Array<Record<string, unknown>> };
  return parsed.agents ?? [];
}

describe.skipIf(!available)("fleet (live, localhost)", () => {
  // A disposable git repo as the workspace: agents run IN PLACE there
  // (`--transfer none`, see src/backends/mngr.ts's workspaceFlags), so this
  // must NEVER be the Rhumb checkout — every spawned agent would otherwise
  // operate directly on it.
  let dir: string;
  let registry: AgentRegistry;
  const createdNames: string[] = [];

  beforeAll(() => {
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
    // `-b` also deletes the `mngr/<name>` branch — without it, recreating an
    // agent under the same name later fails with "branch already exists"
    // (same precedent as backend-mngr.integration.test.ts's destroyMngrAgent).
    for (const name of createdNames) {
      try {
        execFileSync("mngr", ["destroy", name, "--force", "-b"], { stdio: "pipe" });
      } catch (e) {
        console.error(`[live-test cleanup] failed to destroy mngr agent "${name}":`, e);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "spawns two real mngr agents via createFleetOps, each bound to a distinct principal with the right labels",
    { timeout: 600_000 },
    async () => {
      const spec = { model: "claude-opus-4-8", workspace: dir, permissionMode: "acceptEdits", extraOptions: {} };
      const backend = createMngrBackend({
        exec: createRealExec(),
        registry,
        // A real token exercises a real model turn; a fixture token still
        // proves the spawn/bind/label mechanism (the CLI reaches a live
        // prompt and answers with an auth error, itself a genuine transcript
        // entry) — same posture as backend-mngr.integration.test.ts. Either
        // way this test's assertions below do not depend on which.
        credentialEnv: process.env.CLAUDE_CODE_OAUTH_TOKEN
          ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
          : { CLAUDE_CODE_OAUTH_TOKEN: "rhumb-live-test-fixture-token" },
        spec,
      });
      // This is the SAME wiring buildApp (src/index.ts) builds for the fleet
      // block: real exec, real mngr backend, a registry over a temp
      // workspace, and — critically — the same `liveness`/`lastFinishReason`
      // stubs it passes today (`async () => null`). See the caps object
      // below for what that stub means for what this test can and cannot
      // prove.
      const ops = createFleetOps({
        backend,
        registry,
        caps: { maxPerSpawn: 8, maxConcurrent: 8, maxDepth: 1, maxCollectWaitMs: 600_000 },
        spec,
        mintName: () => {
          const n = `fleet-live-${randomUUID().slice(0, 8)}`;
          createdNames.push(n);
          return n;
        },
        // Honest `null` stubs, matching src/index.ts exactly (see buildApp's
        // fleetOps construction and its doc comment). `null` means
        // UNKNOWABLE: `check` can only ever report "unknown" for a bound
        // agent, and `collect` — gated on status === "done" — can never
        // settle to a real result in this slice. That is why this test
        // asserts "check returns a valid AgentStatus" rather than "check
        // returns done" and does not call `collect` at all: awaiting it here
        // would only ever time out, proving nothing beyond what `check`
        // already proves for free.
        //
        // TIGHTEN ONCE REAL LIVENESS LANDS (see Follow-ups in the task
        // brief): swap these for a real `mngr list --format json` adapter
        // and a transcript-based finish-reason reader, then this test's
        // final assertion can move from "status is some valid AgentStatus"
        // to "status === 'done'", and a `collect` call can be added that
        // asserts real result text.
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

      // Each principal is bound to its own distinct real mngr agent.
      const natives = ids.map((id) => registry.get(id)?.nativeId);
      expect(natives.every(Boolean)).toBe(true);
      expect(new Set(natives).size).toBe(2);

      // Lineage recorded locally for both.
      for (const id of ids) {
        expect(registry.get(id)?.depth).toBe(1);
      }

      // Live proof against mngr's OWN listing, not just what the local
      // registry believes: each spawned agent carries the Rhumb principal id
      // and depth as labels (see argvCreate in src/backends/mngr.ts).
      const liveAgents = listMngrAgents();
      for (const id of ids) {
        const native = registry.get(id)?.nativeId;
        const match = liveAgents.find((a) => a.id === native);
        expect(match, `expected mngr list to contain agent ${native}`).toBeDefined();
        const labels = match?.labels as Record<string, unknown> | undefined;
        expect(labels?.rhumb_agent_id).toBe(id);
        expect(String(labels?.rhumb_depth)).toBe("1");
      }

      // `check` must return a value from the real AgentStatus union for
      // every id. This part is the DURABLE assertion: it holds whatever
      // liveness reports, now or later.
      const statuses = await ops.check(ids);
      expect(statuses).toHaveLength(2);
      for (const s of statuses) {
        expect(ALL_STATUSES).toContain(s.status);
      }

      // M4: the assertion below is a CURRENT-BUILD CEILING, not a durable
      // invariant, and it is deliberately written to FAIL when that ceiling
      // is lifted. With liveness/lastFinishReason hard-wired to null (the
      // same stubs src/index.ts passes), `deriveAgentStatus` structurally
      // cannot report anything but "unknown" for a bound agent
      // (src/fleet/status.ts) — pinned here so this test documents the
      // ceiling rather than hiding it, and so nobody can believe `check`
      // works from a green live run. An earlier version of this comment
      // claimed the assertion "keeps passing, unchanged, once real liveness
      // wiring lands", which was never true of the line beneath it.
      //
      // WHEN REAL LIVENESS LANDS: delete this assertion (and the stub
      // `liveness`/`lastFinishReason` above), replacing it with
      // `status === "done"` plus a `collect` call asserting real result text.
      // A failure here after that work is the expected, correct signal —
      // not a flake.
      expect(statuses.every((s) => s.status === "unknown")).toBe(true);
    },
  );
});
