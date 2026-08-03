# mngr agent backend — design

**Date:** 2026-08-03
**Status:** approved, not yet implemented
**Scope:** slice 1 of 5 toward "ontology over agents"

## Why

Rhumb models *what agents touch* — surfaces, with trust, write-back approval, and
audit built around them. It has no model of *what agents are*. Today an "agent" is
an implicit Claude Code `session_id` against one fixed workspace, run in-process
through the Agent SDK (`agent-host/src/sessionManager.ts`). There is no lifecycle,
no parallelism, no host placement, no isolation.

[`imbue-ai/mngr`](https://github.com/imbue-ai/mngr) (MIT) supplies exactly that
missing half: agents as first-class nouns that can be created, listed, placed on
hosts/providers, forked, and snapshotted. Adopting it gives Rhumb an agent ontology
that is the dual of its surface ontology.

Source review of mngr established the division of labor this design depends on:

- mngr agent ids are random UUID4s minted per create; a fork or snapshot-restore
  gets a **fresh** id under default configuration.
- The id is nonetheless plaintext, user-settable (`mngr create --id`), and carries
  no attestation.

Therefore: **a mngr agent id is an identifier, not a credential.** The trust
principal stays Rhumb-owned, and the mngr agent is a runtime *binding* to it.

## Decomposition

The full vision is multi-subsystem and is deliberately split. Each slice is its own
spec → plan → build, and each depends on the previous one.

1. **Execution binding + `AgentBackend`** (this spec) — agent-host only.
2. **Agent registry + principal** — the ontology's durable data layer.
3. **Trust binding** — trust edge becomes Rhumb-principal × surface, executed-via
   mngr agent. Sharpens F22.
4. **Dashboard surface** — dashboard-host + client; list/create/stop, per-agent
   transcripts, trust state.
5. **Multi-host + fork/snapshot** — SSH/Docker/Modal providers.

This spec covers slice 1 only. Slice 1 is localhost-only.

## Non-goals

- No `fork` or `snapshot` in the interface (slice 5).
- No remote/multi-host execution (slice 5).
- No client or dashboard-host changes (slice 4).
- No changes to the trust, surface, write-back, or audit layers (slice 3).
- No migration of existing sessions.

## Phase 0 — feasibility gate

Phase 0 runs **before** interface signatures are finalized. Its purpose is to
avoid designing the abstraction blind. Each question has a defined failure
response.

**Q1 — Does `mngr create` spawn a working Claude Code agent locally?**
Install tmux (the only missing prerequisite; Python 3.12.13, uv 0.11.16, jq, git,
node 24, and claude CLI 2.1.196 are all present). Install mngr via uv. Create an
agent, send a prompt, receive a real answer.
*Failure:* stop. The direction is moot.

**Q2 — Can Rhumb dictate the exact credential environment? (security-critical)**
Rhumb currently guarantees the spawned CLI receives exactly `credentialEnv` and no
ambient credential (`agent-host/src/provider.ts`, `env.ts`). Inserting mngr
lengthens the chain to `agent-host → mngr CLI → tmux server → claude`. The specific
hazard is tmux daemon environment inheritance: tmux sessions inherit from the tmux
*server*, so a pre-existing server can supply an ambient credential Rhumb believed
it had stripped.

Verification is empirical. Plant a decoy ambient credential var, spawn an agent
through mngr, and inspect the real process environment (`ps eww <claude-pid>`).
Assert that the credential vars are exactly those Rhumb injected and that the decoy
did not survive.
*Failure:* mngr requires an env-scrubbing wrapper at agent start, or adoption is
blocked. Either outcome is known within an hour rather than after the interface is
built.

**Q3 — Incremental streaming or poll-after-completion?**
Determines whether `send()` streams or polls. On the localhost provider a
mngr-spawned Claude Code writes its transcript JSONL to the same location Rhumb
already reads (`agent-host/src/sessions.ts`), so tailing that file is the expected
path to incremental events.
*Failure (poll-only):* `send()` polls. Degraded responsiveness, still viable.

## Architecture

### The interface

```ts
export type BackendId = "sdk" | "mngr";

export interface AgentRef {
  /** Rhumb-owned durable principal. Minted and persisted by Rhumb.
   *  This is what trust edges key on (slice 3). Never mngr's id. */
  agentId: string;
  /** Backend-native handle: SDK session_id, or mngr agent id.
   *  Opaque, ephemeral, attacker-settable → identifier, NOT credential. */
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
  /** Idempotent. Ensures a live agent exists for this Rhumb principal. */
  ensure(agentId: string, spec: AgentSpec): Promise<AgentRef>;
  /** Send a prompt; stream events as they arrive. `nativeId` may be populated
   *  during the first turn (the SDK learns its session_id mid-stream). */
  send(ref: AgentRef, prompt: string, onEvent: (e: AgentEvent) => void): Promise<AgentRef>;
  list(): Promise<AgentRef[]>;
  stop(ref: AgentRef): Promise<void>;
  transcript(ref: AgentRef): Promise<TranscriptMessage[] | null>;
}
```

### Why `ensure` rather than `create`

It is the one primitive both backends satisfy without lying. The SDK has no
creation step — a `session_id` emerges from the first turn. mngr is the inverse:
create first, then message. `ensure(agentId)` is a lazy no-op for SDK and a
create-if-absent for mngr.

### Why the two-id split is load-bearing

`agentId` is the durable Rhumb principal; `nativeId` is the disposable runtime
binding. Because a mngr fork mints a new `nativeId`, a forked agent inherits **no**
trust — the F22-correct behavior follows from the type, not from discipline. The
security conclusion is made structural rather than conventional.

### mngr backend mechanics (localhost only)

| Method | Implementation |
| --- | --- |
| `ensure` | `mngr list` → if no agent for this `agentId`, `mngr create` with Rhumb-built env; persist `nativeId` |
| `send` | Write prompt to the agent; tail transcript JSONL; translate lines → `AgentEvent` (reusing the existing `blockToMessages` logic) |
| `list` | `mngr list` JSON output, joined against Rhumb's principal records |
| `stop` | mngr stop/kill for that `nativeId` |
| `transcript` | Reuse the existing JSONL reader |

The exact CLI invocations (subcommands, flags, and output format) are treated as
unverified until Phase 0 confirms them against the installed version; the table
states intent, not a pinned command line.

All mngr CLI interaction goes through a single injected `exec` seam, so the backend
is unit-testable with a fake. This mirrors how `SessionManager` already receives
`query` by injection.

### Persistence

A new `ws/agents.json` index holds principal records:
`{ agentId, nativeId, backend, name, createdAt, lastActiveAt, status }`. Written
with the atomic tmp+rename pattern already used by `sessions.ts` and `fsAtomic.ts`.
Slice 1 needs it only to survive restarts and to answer which mngr agent belongs to
a given principal; slice 2 grows it into the full registry.

### Backward compatibility

The SDK backend uses `agentId === nativeId === session_id` (identity mapping). All
existing sessions keep working and `sessions.json` is untouched. Only the mngr
backend mints a distinct Rhumb principal — which is precisely where the split earns
its keep. No migration of live dogfood data.

### Wiring

`POST /messages` keeps its current shape (`agent-host/src/server.ts`); the
`sessionId` field now carries the `agentId`. No client or dashboard-host change.

`SessionManager` becomes a delegator: its model/workspace/permissionMode/options
building moves verbatim into `backends/sdk.ts`. `SessionManager.run()` retains its
exact signature so `server.ts`'s `ManagerLike` contract is unchanged; internally it
resolves the ref and delegates to `backend.send()`.

Backend selection is `RHUMB_AGENT_BACKEND=sdk|mngr`, defaulting to `sdk`. It is
validated eagerly at boot in `env.ts`; when `mngr` is selected, startup also
verifies the `mngr` and `tmux` binaries are present and fails fast with an
actionable message. This follows the precedent set by commits `462acd6`
(validate eagerly) and `fb30c3d` (fail closed).

## Error handling

Every failure mode — mngr non-zero exit, dead agent, unreachable host, missing
binary — surfaces as the existing `{ type: "error" }` `AgentEvent`, the channel
`SessionManager` already uses. No new error surface for the client to learn.
A dead agent detected during `ensure()` is re-created rather than failing the turn.

## Testing

Test-driven, following the existing vitest + dependency-injection style.

- Both backends unit-tested against injected fakes: a fake `query` for SDK (as
  today), a fake `exec` for mngr. No real tmux or network in unit tests.
- **A shared conformance suite runs against both backends** — identical assertions
  for `ensure` idempotence, `send` event ordering, `stop`, and `transcript`. This
  is what keeps the abstraction honest rather than SDK-shaped with mngr bolted on.
- Existing `sessionManager.test.ts` and `server.test.ts` must pass **unmodified**,
  proving the refactor is behavior-preserving.
- Phase 0's credential assertion (Q2) becomes a permanent integration test, tagged
  so it runs only where mngr is installed.

## Compliance

Unchanged. COMPLIANCE.md's subscription-mode constraint concerns *offering*
claude.ai login or rate limits to other people. One operator running multiple
agents on their own token, self-hosted, with no brokering, remains inside the
personal-tool model. Slice 1 adds no new exposure, and Q2 exists specifically to
preserve Rhumb's existing credential-control guarantee.

## Risks

| Risk | Mitigation |
| --- | --- |
| tmux env inheritance leaks an ambient credential | Q2 is a hard gate with an empirical test; becomes a permanent regression test |
| Interface designed to fit SDK, not mngr | Shared conformance suite; signatures finalized only after Phase 0 |
| mngr is a young dependency (~400★) | Confined behind `AgentBackend`; `sdk` remains the default and the fallback |
| Importing a second ontology doubles sync cost (chip `task_0055b835`) | The two ontologies join by spawn-time *binding*, never identity equality |
