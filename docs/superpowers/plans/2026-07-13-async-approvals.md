# Async Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gated infra actions become durable proposals: parked by scheduled sessions, executed only on operator approval (operate-loop slice 2).

**Architecture:** `PendingActions` gains modes/statuses/persistence; the infra tool handlers' cores extract into `createGatedExecutor`; `makeCanUseTool` gains a parking flavor; the infra router executes approved parked entries in the background; the watchdog's disallow list shrinks to built-ins + destroy tools and its manager gets the parking gate.

**Tech Stack:** TypeScript/vitest (agent-host), minor React (client). No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-async-approvals-design.md`.
- Blocking-gate behavior for interactive sessions is byte-compatible with today (existing gating tests keep passing unmodified where possible).
- Nothing executes without operator approval; watchdog can never propose `destroy_vm`/`destroy_service` (structural).
- Resolve endpoint answers immediately; parked execution is background.
- ESM `.js` suffixes.

---

### Task 1: PendingActions v2 — modes, statuses, persistence, boot expiry

**Files:** Modify `agent-host/src/infra/pending.ts`, `agent-host/src/infra/types.ts`; Test `agent-host/test/pending.test.ts` (extend existing or create).

**Interfaces:** `PendingAction` gains `mode: "blocking" | "parked"`, `status: "pending" | "approved" | "denied" | "executed" | "failed" | "expired"`, `proposedBy: "interactive" | "watchdog"`, `resolvedAt?: string`, `result?: string`, `error?: string`. `PendingActions` constructor gains `persistPath?: string` (load on construct, atomic-save on every change via `fsAtomic`). `enqueue(tool, input, opts?: { mode?: "blocking" | "parked"; proposedBy?: "interactive" | "watchdog" })` (defaults blocking/interactive). New: `get(pendingId): PendingAction | undefined`; `recordOutcome(pendingId, outcome: "executed" | "failed", detail: string): boolean` (sets status + result/error, persists, emits the outcome as the listener kind). Listener kind widens to `"added" | "resolved" | "executed" | "failed"`. `resolve()` sets status approved/denied + `resolvedAt`, persists, still settles the promise for blocking entries. Boot rules per spec (blocking pending → expired; parked pending → alive; parked approved w/o outcome → failed with restart note).

Steps: failing tests (lifecycle for both modes; persistence round-trip via a second instance on the same path; the three boot rules; outcome events fire; `list()` returns only status "pending") → red → implement → green (plus existing infra gating tests untouched) → commit `feat(agent-host): durable pending actions with parked mode`.

### Task 2: Extract `createGatedExecutor`

**Files:** Create `agent-host/src/infra/executor.ts`; Modify `agent-host/src/infra/server.ts` (handlers delegate); Test `agent-host/test/infra-executor.test.ts`.

**Interfaces:** `createGatedExecutor(deps: InfraDeps): { execute(tool: GatedTool, input: Record<string, unknown>): Promise<string> }` — returns each tool's current success text, throws on failure, fires `onMutate` for exactly the tools that call `mutated()` today (create_vm, destroy_vm, provision_database, spawn/redeploy/stop/start/destroy_service — NOT start/stop/resize_vm). `createInfraServer` builds one executor and each gated handler becomes `try { return ok(await executor.execute("<tool>", a)) } catch (e) { return fail(String(e)) }`.

Steps: failing executor tests (per-tool dispatch against fakes; onMutate exactness; unknown tool throws; services-not-configured error preserved) → red → implement → green (existing infra server/gating tests must pass unchanged) → commit `refactor(agent-host): gated tool cores behind createGatedExecutor`.

### Task 3: Parking gate + execute-on-approve

**Files:** Modify `agent-host/src/infra/server.ts` (`makeCanUseTool` opts), `agent-host/src/infra/router.ts`, `agent-host/src/infra/types.ts` (`InfraAuditEntry.decision` union + `"parked" | "executed"`), `agent-host/src/index.ts` (wire persistPath, executor, router deps); Test existing infra gating tests + router tests.

**Interfaces:** `makeCanUseTool(deps, opts?: { mode?: "blocking" | "parked"; proposedBy?: "interactive" | "watchdog" })` — parked branch: enqueue parked, audit `parked`, immediately return deny with "Queued for operator approval as <id>. It will execute only if the operator approves — do not retry; note the proposal in your report." `createInfraRouter` deps gain `executeParked?: (a: PendingAction) => Promise<void>`; resolve handler: look up entry before resolving; after a parked approve, `void deps.executeParked?.(entry)` and respond `{ ok: true }` immediately. `index.ts` builds `executeParked` = executor.execute → `pending.recordOutcome` → audit (`executed` with result / `error` with message); `PendingActions` constructed with `persistPath: <workspace>/pending-actions.json`.

Steps: failing tests (parked canUseTool returns deny+id without waiting and audits `parked`; blocking path regression-green; router approve-parked answers 200 then records executed via awaited fake executor; deny-parked records without executing) → red → implement → green (full suite + build) → commit `feat(agent-host): parking gate with execute-on-approve`.

### Task 4: Watchdog proposes

**Files:** Modify `agent-host/src/watchdog.ts`, `agent-host/src/index.ts` (watchdog manager gets parking canUseTool when infra configured); Test `agent-host/test/watchdog.test.ts`, `agent-host/test/index.smoke.test.ts`.

**Interfaces:** `watchdogDisallowedTools()` (no arg now) returns `["AskUserQuestion","Bash","Write","Edit","NotebookEdit","mcp__infra__destroy_vm","mcp__infra__destroy_service"]`. `WATCHDOG_PROMPT` gains the proposal paragraph (one-step remediation, note ids, never retry, destroys unavailable). `watchdogExtraOptions` adds `canUseTool: makeCanUseTool(gateDeps, { mode: "parked", proposedBy: "watchdog" })` inside the infra-configured block.

Steps: update failing tests (disallow list: destroys + built-ins in, other gated tools OUT; prompt mentions proposals; smoke: watchdog tick options carry a canUseTool and the narrowed disallow list) → red → implement → green → commit `feat(agent-host): watchdog proposes parked remediations`.

### Task 5: Client — show the proposer

**Files:** Modify `client/src/lib/pendingStore.ts` (map `proposedBy` from infra payloads), `client/src/components/ConfirmationDialog.tsx` (render "proposed by watchdog" when present); Test both existing test files.

Steps: failing tests (reducer threads proposedBy; dialog shows the label for a watchdog item and omits it for interactive; unknown event kinds still ignored) → red → implement → green (tsc + full client suite) → commit `feat(client): label watchdog proposals in the confirmation dialog`.

### Task 6: Verify + PR

Full suites (agent-host, dashboard-host, client + cargo), push `feat/async-approvals`, PR linking the spec. Merge + deploy + propose-approve-heal dogfood follow with explicit user approval.
