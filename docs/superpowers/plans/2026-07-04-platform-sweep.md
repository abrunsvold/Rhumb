# Platform Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five small fixes per `docs/superpowers/specs/2026-07-04-platform-sweep-design.md`: atomic registry writes (M2), ssh error sanitization (M4), ontology auto-sync on infra mutations (F16), AskUserQuestion disallow+steer (F7), durable HTTP-driving runbook.

**Architecture:** All in `agent-host/`. Two new leaf modules (`fsAtomic.ts`, `prompt.ts`), surgical edits to `registry.ts`/`provision.ts`/`ssh.ts`/`infra/server.ts`/`index.ts`, one README section. Everything dependency-injected in the existing style; tests use existing fixtures (`test/infra-server.test.ts` already has a `callTool` helper from the redeploy branch).

**Tech Stack:** TypeScript (Node 20, ESM, `.js` import suffixes), vitest, supertest (already used by `index.smoke.test.ts`).

## Global Constraints

- Ontology sync trigger list, exactly (spec §1): `create_vm`, `destroy_vm`, `provision_database`, `spawn_service`, `redeploy_service`, `stop_service`, `start_service`, `destroy_service` — successful mutations only; best-effort and swallowed at BOTH the call site in server.ts and the callback in index.ts; read-only tools never trigger.
- Atomic write: same-directory `<path>.tmp-<pid>` then `renameSync`; best-effort tmp unlink on failure, original error rethrown. Adopters: `services/registry.ts` and `infra/provision.ts` `appendDataSource` ONLY (sessions.ts already does tmp+rename; ontology vault out of scope).
- ssh errors: thrown message is `ssh <command|copy> failed (exit <code>)[: <redacted stderr tail ≤400 chars>]`; the original command line NEVER appears; redaction replaces any line matching `/Environment=|postgres:\/\/|TOKEN|PASSWORD|PRIVATE KEY/i` with `[redacted line]`.
- F7: `disallowedTools: ["AskUserQuestion"]` + `systemPrompt: { type: "preset", preset: "claude_code", append: RHUMB_PROMPT_APPEND }` set unconditionally on session options (verified against installed SDK 0.1.77: both option shapes exist in sdk.mjs).
- Commit messages end with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. Focused tests while iterating; full `cd agent-host && npm test` (and `npm run build` when src changes) before each commit.

---

### Task S1: fsAtomic + registry/data-sources adoption (M2)

**Files:**
- Create: `agent-host/src/fsAtomic.ts`
- Modify: `agent-host/src/services/registry.ts:13-17` (the `write` helper)
- Modify: `agent-host/src/infra/provision.ts:7-21` (`appendDataSource`)
- Test: `agent-host/test/fs-atomic.test.ts` (new)

**Interfaces:**
- Produces: `atomicWriteFileSync(path: string, data: string): void` from `src/fsAtomic.ts` (creates parent dirs itself).

- [ ] **Step 1: Write the failing test** — `agent-host/test/fs-atomic.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "../src/fsAtomic.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-atomic-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("atomicWriteFileSync", () => {
  it("writes content, creates parent dirs, leaves no tmp residue", () => {
    const p = join(dir, "nested", "reg.json");
    atomicWriteFileSync(p, '{"a":1}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}');
    expect(readdirSync(join(dir, "nested")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("replaces an existing file atomically (rename over)", () => {
    const p = join(dir, "reg.json");
    writeFileSync(p, "old");
    atomicWriteFileSync(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
  });

  it("cleans up the tmp file and rethrows when the rename fails", () => {
    const p = join(dir, "target");
    mkdirSync(join(p, "occupied"), { recursive: true });   // target is a non-empty DIRECTORY → renameSync throws
    expect(() => atomicWriteFileSync(p, "data")).toThrow();
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);  // tmp unlinked
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/fs-atomic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `agent-host/src/fsAtomic.ts`:

```ts
import { writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Same-directory write-then-rename: the rename is atomic on POSIX, so readers
// never observe a partially-written file. A crash mid-write previously left
// corrupt JSON that loaders read as [] — silently wiping the registry.
export function atomicWriteFileSync(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}
```

`registry.ts` — replace the `write` helper body (drop the now-redundant fs imports it no longer needs):

```ts
import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync } from "../fsAtomic.js";
// ...
function write(path: string, list: ServiceEntry[]): ServiceEntry[] {
  atomicWriteFileSync(path, JSON.stringify(list, null, 2));
  return list;
}
```

`provision.ts` `appendDataSource` — swap its `mkdirSync` + `writeFileSync(path, ...)` pair for `atomicWriteFileSync(path, JSON.stringify(next, null, 2))` (import from `../fsAtomic.js`; keep everything else identical).

- [ ] **Step 4: Run to verify pass**

Run: `cd agent-host && npx vitest run test/fs-atomic.test.ts test/service-ops.test.ts test/infra-provision.test.ts`
Expected: PASS (registry/provision behavior unchanged on success paths).

- [ ] **Step 5: Full suite + commit**

```bash
cd agent-host && npm test && npm run build
git add agent-host/src/fsAtomic.ts agent-host/src/services/registry.ts agent-host/src/infra/provision.ts agent-host/test/fs-atomic.test.ts
git commit -m "fix(agent-host): atomic tmp+rename writes for services and data-sources registries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task S2: ssh error sanitization (M4)

**Files:**
- Modify: `agent-host/src/services/ssh.ts`
- Test: `agent-host/test/service-ssh.test.ts` (new)

**Interfaces:**
- Produces: `redactSshError(verb: "command" | "copy", e: unknown): Error` exported from `ssh.ts` (pure, unit-testable); `run`/`pushDir` rethrow via it.

- [ ] **Step 1: Write the failing test** — `agent-host/test/service-ssh.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { redactSshError } from "../src/services/ssh.js";

const SECRET = "postgres://printers:s3cretpw@192.168.1.91:5432/printers";

describe("redactSshError", () => {
  it("never includes the original message (which embeds the command line)", () => {
    const e = Object.assign(new Error(`Command failed: ssh ... cat > unit <<EOF\nEnvironment=DATABASE_URL=${SECRET}\nEOF`), { code: 1, stderr: "" });
    const out = redactSshError("command", e);
    expect(out.message).not.toContain("postgres://");
    expect(out.message).not.toContain("s3cretpw");
    expect(out.message).not.toContain("Environment=");
    expect(out.message).toContain("exit 1");
  });

  it("redacts secret-bearing lines from the stderr tail but keeps benign lines", () => {
    const e = Object.assign(new Error("boom"), { code: 127, stderr: `bash: line 3: npm: command not found\nEnvironment=DATABASE_URL=${SECRET}\n` });
    const out = redactSshError("command", e);
    expect(out.message).toContain("npm: command not found");
    expect(out.message).toContain("[redacted line]");
    expect(out.message).not.toContain("s3cretpw");
    expect(out.message).toContain("exit 127");
  });

  it("handles missing code/stderr (spawn errors) and the copy verb", () => {
    const out = redactSshError("copy", new Error("spawn scp ENOENT"));
    expect(out.message).toBe("ssh copy failed (exit ?)");
  });

  it("caps the stderr tail at 400 chars", () => {
    const e = Object.assign(new Error("x"), { code: 1, stderr: "a".repeat(1000) });
    expect(redactSshError("command", e).message.length).toBeLessThan(450);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/service-ssh.test.ts`
Expected: FAIL — no `redactSshError` export.

- [ ] **Step 3: Implement** — `agent-host/src/services/ssh.ts` becomes:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SshExec, SshTarget } from "./types.js";

const run = promisify(execFile);
const opts = (t: SshTarget) => [
  "-i", t.privateKeyPath,
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
];

const SECRET_LINE = /Environment=|postgres:\/\/|TOKEN|PASSWORD|PRIVATE KEY/i;

// execFile rejections embed the full command line — which for unit-file writes
// includes Environment= lines carrying data-source connection strings. Rebuild
// the error from exit code + a redacted stderr tail; the command never appears.
export function redactSshError(verb: "command" | "copy", e: unknown): Error {
  const err = e as { code?: number | string; stderr?: string };
  const code = err?.code ?? "?";
  const tail = String(err?.stderr ?? "").slice(-400)
    .split("\n")
    .map((l) => (SECRET_LINE.test(l) ? "[redacted line]" : l))
    .join("\n")
    .trim();
  return new Error(`ssh ${verb} failed (exit ${code})${tail ? `: ${tail}` : ""}`);
}

export function createSshExec(): SshExec {
  return {
    async run(target: SshTarget, command: string) {
      try {
        const { stdout, stderr } = await run("ssh", [...opts(target), `${target.user}@${target.host}`, command], { maxBuffer: 8 * 1024 * 1024 });
        return { stdout, stderr };
      } catch (e) {
        throw redactSshError("command", e);
      }
    },
    async pushDir(target: SshTarget, localDir: string, remoteDir: string) {
      // -r recursive; trailing /. copies contents into remoteDir
      try {
        await run("scp", ["-r", ...opts(target), `${localDir}/.`, `${target.user}@${target.host}:${remoteDir}`], { maxBuffer: 8 * 1024 * 1024 });
      } catch (e) {
        throw redactSshError("copy", e);
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd agent-host && npx vitest run test/service-ssh.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

```bash
cd agent-host && npm test && npm run build
git add agent-host/src/services/ssh.ts agent-host/test/service-ssh.test.ts
git commit -m "fix(services): sanitize ssh exec errors — no command line, redacted stderr tail

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task S3: ontology auto-sync on infra mutations (F16)

**Files:**
- Modify: `agent-host/src/infra/server.ts` (deps + the 8 mutating tool handlers)
- Modify: `agent-host/src/index.ts` (hoist `ontologyOps` above the infra block; pass `onMutate`)
- Test: `agent-host/test/infra-server.test.ts`

**Interfaces:**
- Consumes: existing `callTool` helper in `test/infra-server.test.ts`; `ontologyOps.sync()` (existing).
- Produces: `createInfraServer` deps gain `onMutate?: () => void`.

- [ ] **Step 1: Write the failing tests** — append to `test/infra-server.test.ts` (reuse its `callTool(name, args, deps)` helper and existing fake `serviceOps` stub shape):

```ts
describe("onMutate (ontology auto-sync)", () => {
  it("fires once after a successful mutation and its own throw never fails the tool", async () => {
    let fired = 0;
    const serviceOps = { ...fakeServiceOps, stop: async () => {} };
    const ok1 = await callTool("stop_service", { id: "sales" }, { serviceOps, onMutate: () => { fired++; } });
    expect(ok1).toContain("stopped");
    expect(fired).toBe(1);
    const ok2 = await callTool("stop_service", { id: "sales" }, { serviceOps, onMutate: () => { throw new Error("sync exploded"); } });
    expect(ok2).toContain("stopped");           // tool result unaffected by onMutate failure
  });

  it("does not fire when the underlying op fails", async () => {
    let fired = 0;
    const serviceOps = { ...fakeServiceOps, stop: async () => { throw new Error("nope"); } };
    const res = await callTool("stop_service", { id: "sales" }, { serviceOps, onMutate: () => { fired++; } });
    expect(res).toContain("nope");
    expect(fired).toBe(0);
  });

  it("does not fire for read-only tools", async () => {
    let fired = 0;
    const serviceOps = { ...fakeServiceOps, list: () => [] };
    await callTool("list_services", {}, { serviceOps, onMutate: () => { fired++; } });
    expect(fired).toBe(0);
  });
});
```

(Adapt the stub/deps names to the file's actual fixtures. If `callTool`'s `deps` type rejects `onMutate` before implementation, that IS the expected compile-fail for RED.)

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/infra-server.test.ts`
Expected: FAIL — `onMutate` not a known dep / never called.

- [ ] **Step 3: Implement**

`infra/server.ts`: add `onMutate?: () => void` to the `createInfraServer` deps type. Add one helper inside `createInfraServer`:

```ts
// Best-effort post-mutation hook (ontology auto-sync). Never affects the tool result.
const mutated = () => { try { deps.onMutate?.(); } catch { /* swallowed */ } };
```

In EXACTLY these 8 handlers — `create_vm`, `destroy_vm`, `provision_database`, `spawn_service`, `redeploy_service`, `stop_service`, `start_service`, `destroy_service` — insert `mutated();` after the awaited operation succeeds and before the `return ok(...)`. Do NOT touch `start_vm`, `stop_vm`, `resize_vm` (spec's list is exact), nor any read-only tool.

`index.ts`: move the ontology-ops construction (the `const onto = loadOntologyConfig(...)`, `readJson`, `readJsonl`, and `const ontologyOps = createOntologyOps({...})` block) ABOVE the `if (infra.proxmox && infra.pgAdmin)` block. Leave `createOntologyServer(ontologyOps)` + its `mcpServers`/`allowedTools` registration exactly where they are (after the infra block — the merge order there is load-bearing: infra assigns `mcpServers = { infra: server }`, ontology then spreads it). Add to the `createInfraServer` deps:

```ts
onMutate: () => { try { ontologyOps.sync(); } catch { /* never fail the infra op */ } },
```

- [ ] **Step 4: Run to verify pass**

Run: `cd agent-host && npx vitest run test/infra-server.test.ts test/index.smoke.test.ts`
Expected: PASS (smoke tests confirm the reorder didn't break boot paths).

- [ ] **Step 5: Full suite + commit**

```bash
cd agent-host && npm test && npm run build
git add agent-host/src/infra/server.ts agent-host/src/index.ts agent-host/test/infra-server.test.ts
git commit -m "feat(infra): ontology auto-sync after successful gated mutations (F16)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task S4: AskUserQuestion disallow + steer (F7)

**Files:**
- Create: `agent-host/src/prompt.ts`
- Modify: `agent-host/src/index.ts:34` area (session options init)
- Test: `agent-host/test/prompt.test.ts` (new) + extend `agent-host/test/index.smoke.test.ts`

**Interfaces:**
- Produces: `RHUMB_PROMPT_APPEND: string` from `src/prompt.ts`; session options carry `disallowedTools` + `systemPrompt`.

- [ ] **Step 1: Write the failing tests**

`agent-host/test/prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RHUMB_PROMPT_APPEND } from "../src/prompt.js";

describe("RHUMB_PROMPT_APPEND", () => {
  it("explains the operator gate and forbids pre-asking", () => {
    expect(RHUMB_PROMPT_APPEND).toContain("operator approval");
    expect(RHUMB_PROMPT_APPEND).toContain("Call tools directly");
    expect(RHUMB_PROMPT_APPEND).toContain("plain text");
  });
});
```

Extend `test/index.smoke.test.ts` with (uses the injected fake `query` to capture options):

```ts
it("sessions disallow AskUserQuestion and append the Rhumb system prompt", async () => {
  let captured: Record<string, unknown> | undefined;
  const app = buildApp({
    config: { port: 0, model: "m", workspace: "./ws", oauthToken: "tok", permissionMode: "acceptEdits", allowedUsers: [], insecureDev: true },
    query: (args: { options?: Record<string, unknown> }) => {
      captured = args.options;
      return (async function* () { yield { type: "result", result: "", is_error: false }; })();
    },
  });
  await request(app).post("/messages").send({ prompt: "hi" });
  for (let i = 0; i < 100 && !captured; i++) await new Promise((r) => setTimeout(r, 10));
  expect(captured?.disallowedTools).toContain("AskUserQuestion");
  const sp = captured?.systemPrompt as { type: string; preset: string; append: string };
  expect(sp).toMatchObject({ type: "preset", preset: "claude_code" });
  expect(sp.append).toContain("operator approval");
});
```

(If the existing fake-query signature differs — check the top of the file — adapt the capture accordingly; the existing first test shows the exact `query:` shape used.)

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/prompt.test.ts test/index.smoke.test.ts`
Expected: FAIL — no prompt module; captured options lack the fields.

- [ ] **Step 3: Implement**

`agent-host/src/prompt.ts`:

```ts
// Appended to the claude_code preset system prompt for every Rhumb session.
// Twice-observed failure mode (dogfood runs 1 and 2): the agent bounces a
// goal-directed turn back as AskUserQuestion, which nothing in this headless
// platform can answer. Explain the gate; forbid pre-asking.
export const RHUMB_PROMPT_APPEND = [
  "You are the build agent of Rhumb, a self-hosted internal-tools platform.",
  "Destructive and infrastructure actions (VMs, databases, service spawn/redeploy/destroy) are operator-gated automatically: calling the tool queues the action for operator approval and blocks until they decide. Call tools directly; never ask for permission first.",
  "Sessions are driven headlessly — interactive Q&A mid-turn is impossible, and the AskUserQuestion tool is disabled.",
  "If you genuinely need operator input, state the question in plain text in your reply and end your turn.",
].join("\n");
```

`index.ts` — immediately after `const sessionExtraOptions: Record<string, unknown> = {};` add:

```ts
sessionExtraOptions.disallowedTools = ["AskUserQuestion"];
sessionExtraOptions.systemPrompt = { type: "preset", preset: "claude_code", append: RHUMB_PROMPT_APPEND };
```

with `import { RHUMB_PROMPT_APPEND } from "./prompt.js";` added to the imports.

- [ ] **Step 4: Run to verify pass**

Run: `cd agent-host && npx vitest run test/prompt.test.ts test/index.smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

```bash
cd agent-host && npm test && npm run build
git add agent-host/src/prompt.ts agent-host/src/index.ts agent-host/test/prompt.test.ts agent-host/test/index.smoke.test.ts
git commit -m "feat(agent-host): disallow AskUserQuestion and steer via system-prompt append (F7)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task S5: durable HTTP-driving runbook

**Files:**
- Modify: `agent-host/README.md` (append section after "## API")
- Modify: `docs/superpowers/plans/2026-07-04-day2-dogfood-filament.md` (footnote beside the stale recipe in Task 4 Step 2)

**Interfaces:** none (docs only). No test steps; verification is proofreading against the identity-mode reality proven live (Sec-Rhumb-Control isolation-tested 2026-07-04).

- [ ] **Step 1: Append to `agent-host/README.md`:**

```markdown
## Driving and approving over HTTP

In identity mode (the default), every control-plane request must arrive through
`tailscale serve` with a tailnet identity on the allowlist, AND carry the shell
header `Sec-Rhumb-Control: 1`. Browsers cannot set `Sec-*` headers, so surface
iframes can never approve their own writes; the Tauri client's Rust proxy sends
the header automatically. For scripting/debugging from a tailnet machine:

    # send a message (starts or continues a session)
    curl -s -X POST -H 'Sec-Rhumb-Control: 1' -H 'content-type: application/json' \
      -d '{"prompt":"hello"}' https://<your-box>.ts.net/agent/messages

    # list pending gated infra actions
    curl -s -H 'Sec-Rhumb-Control: 1' https://<your-box>.ts.net/agent/infra/pending

    # approve (or deny) one
    curl -s -X POST -H 'Sec-Rhumb-Control: 1' -H 'content-type: application/json' \
      -d '{"decision":"approve"}' https://<your-box>.ts.net/agent/infra/pending/<id>/resolve

`Authorization: Bearer <RHUMB_CONTROL_TOKEN>` is only checked in
`RHUMB_INSECURE_DEV=1` mode — against an identity-mode host it returns
`403 {"error":"shell only"}`.
```

- [ ] **Step 2: Footnote the stale recipe.** In `docs/superpowers/plans/2026-07-04-day2-dogfood-filament.md`, directly under the fenced block containing `Authorization: Bearer $TOKEN` (Task 4 Step 2), add:

```markdown
> **STALE (kept for the historical record):** identity mode requires the `Sec-Rhumb-Control: 1` shell header instead of Bearer auth — this recipe 403s against a current deployment. See "Driving and approving over HTTP" in `agent-host/README.md`. Discovered as a finding during the run this plan drove.
```

- [ ] **Step 3: Commit**

```bash
git add agent-host/README.md docs/superpowers/plans/2026-07-04-day2-dogfood-filament.md
git commit -m "docs: durable Sec-Rhumb-Control runbook; mark stale Bearer recipe (task_89f649e0)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** §1→S3, §2→S1, §3→S2, §4→S4, §5→S5. All five items tasked; out-of-scope list respected (no client, no deploy.sh, no vault atomicity).
- **Type consistency:** `atomicWriteFileSync(path, data)` used identically in S1's two adopters; `onMutate?: () => void` named the same in server deps, test deps, and index callback; `RHUMB_PROMPT_APPEND` exact name in prompt.ts/index.ts/tests; `redactSshError` verb union matches both call sites.
- **Known adaptation points (explicitly delegated, not placeholders):** S3/S4 test snippets name the fixtures of their target files (`callTool`, `fakeServiceOps`, the fake-`query` shape) and instruct the implementer to match the file's actual helpers — those files were extended on the same branch and their exact current shapes are authoritative.
