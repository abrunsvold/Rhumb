# Fleet orchestration — design

**Date:** 2026-08-04
**Status:** approved, not yet implemented
**Depends on:** `2026-08-03-mngr-agent-backend-design.md` (slice 1, complete)
**Scope:** P0 + P1 of a four-part program

**Branch dependency:** P0 modifies `agent-host/src/backends/mngr.ts`, which at the
time of writing lives on the unmerged slice 1 branch
(`claude/mngr-repo-evaluation-f81f39`, 22 commits, green). This work should start
from a base where slice 1 has landed; otherwise it stacks a second large slice on
an unreviewed one and the eventual review covers both at once.

## Why

Slice 1 gave Rhumb an agent-execution backend: Claude Code can now run through
the `mngr` CLI, with a Rhumb-owned durable principal bound to each mngr agent.
It runs one agent at a time, driven by one conversation.

The point of adopting mngr was never one agent. It was *many* — "run any coding
agent in parallel, anywhere". This spec is the step that makes that real, and it
makes one specific choice: **the model decides the fan-out.** Rhumb exposes fleet
operations as MCP tools, and Opus chooses whether a job wants one agent or twelve,
and where they run.

That turns agents from infrastructure an operator manages into a resource the
model allocates — the "ontology over agents" this program is named for.

### Why the model, and not the operator

An operator-directed fleet was considered and rejected. It is safer and duller:
you would learn what gating and budgeting need to be before handing over the
trigger. The decision is to design those constraints up front instead. They are
therefore requirements of this spec, not follow-ups:

1. Spawning is a **gated** tool, on the same approval path as infra mutations.
2. Limits are **enforced in Rhumb**, never by prompt.
3. Every spawn is **attributed** — who spawned whom, under whose authorization.

### Why the ~90s turn cost does not sink this

mngr 0.2.17 costs ≥90s per turn (its `mngr message` submission-signal timeout
fires even when the transcript proves delivery and reply within ~2s; see
`docs/dogfood/2026-08-03-mngr-phase0.md`). That makes mngr unusable for
interactive chat and irrelevant for background work: nobody watches a fleet turn
by turn.

This shapes the architecture rather than blocking it. The two backends become
complementary — `sdk` for the foreground conversation, `mngr` for parallel work
launched and collected later.

## Program decomposition

Each part is its own spec → plan → build. **This spec covers P0 and P1.**

- **P0 — Reply correctness.** Know when an agent is finished. Prerequisite:
  orchestration over agents whose completion you cannot detect is not possible.
- **P1 — Gated fleet spawn.** The `fleet` MCP server, its safety envelope, and
  lineage. Localhost only.
- **P2 — Fleet visibility.** Dashboard and client: agent list, lineage tree,
  per-agent transcripts, stop. Today `list`/`stop`/`transcript` exist on the
  backend with no production callers — tolerable for one agent, untenable for
  twelve the operator did not personally launch.
- **P3 — Multi-host placement.** SSH/Docker/Modal, which forces the trust gate
  out of process, since a remote agent cannot reach an in-process MCP server or
  a JS callback. P1 and P2 inform what that gate must do.

P2 and P3 are deliberately not specified yet; they are reassessed after P1 ships.

## Non-goals

- No remote placement. `placement` exists as a parameter with a local default so
  P3 widens it without redesign, but P1 accepts local only.
- No dashboard or client changes (P2).
- No token/cost budgeting (see Deferred).
- No changes to the SDK backend's behaviour. It remains the default and untouched.
- No out-of-process trust gate (P3).

## P0 — Reply correctness

Three defects, carried from slice 1's final review. The third is what blocks
fleet work.

**(a) An empty reply is indistinguishable from silence.** An `assistant_message`
with `text: ""` is emitted as `{ result: "", isError: false }`. For one agent
this is a curiosity; across twelve it makes "finished with nothing to say"
identical to "still thinking".

**(b) `finish_reason` is never consulted.** `send()` returns on the first *new*
assistant message. mngr's transcript carries `finish_reason` (a
`"stop_sequence"` sample is recorded in the Phase 0 doc) and Rhumb ignores it. A
tool-using agent emits narration, then a tool call, then its answer — Rhumb
would return the narration. Unexercised today only because every observed live
turn has been single-message and tool-free.

**(c) There is no agent-status concept.** Fleet needs one.

### Design

- `parseTranscriptLine` carries `finish_reason` through to the mapped event.
- The reply wait requires an assistant message with a **terminal**
  `finish_reason`, not merely a new one. The observed terminal value is
  `"stop_sequence"` (Phase 0 sample); `"end_turn"` is expected but unverified.
  The implementation must treat an **unrecognised** `finish_reason` as
  non-terminal and keep waiting, and log it once — failing open here would
  reintroduce defect (b) for any reason string we did not anticipate.
- An empty-but-terminal reply becomes an explicit "completed with no output"
  outcome, distinct from both a real answer and a timeout.
- A new `AgentStatus` = `working` | `done` | `failed`, derived from **two**
  sources rather than the transcript alone: mngr's own liveness signals
  (`state`, `idle_seconds`, `agent_activity_time`, `runtime_seconds`, all
  present in `mngr list --format json`) combined with the transcript's terminal
  `finish_reason`. mngr already knows when an agent has gone idle; deriving that
  from transcript shape alone would be reimplementing it worse.

## P1 — The `fleet` MCP server

Built with `createSdkMcpServer`, matching `createInfraServer` and
`createOntologyServer`, and registered into `sessionExtraOptions.mcpServers`, so
its tools arrive as `mcp__fleet__*`.

### The decoupling decision

**The fleet server always spawns through the `mngr` backend, regardless of which
backend the parent conversation uses.** A fast `sdk` foreground conversation can
therefore dispatch a background mngr fleet. Fleet is available even when
`RHUMB_AGENT_BACKEND=sdk`; mngr's prerequisites gate the fleet server's
construction, not the whole host.

This is the "sdk foreground, mngr background" split expressed in code, and it is
what makes the ≥90s turn cost tolerable.

### Tools

**`spawn(tasks: Array<{ prompt: string; placement?: string }>)`**
Returns one result per task: a Rhumb **principal** (`agentId`) on success, or a
per-task failure. Never returns mngr ids — the model manipulates the same
durable identity the trust model keys on.

One signature covers both fan-out shapes: *map* is N tasks sharing a prompt with
differing content; *queue* is N unrelated prompts. `placement` is an mngr address
suffix, local by default.

**`spawn` returns immediately.** At ~90s per turn a blocking spawn is unusable.
The model's loop is `spawn` → do other work → `check`/`collect`. The tool
description must state this explicitly, or the model will assume `spawn` implies
completion.

**`check(agentIds: string[])`** → `AgentStatus` per agent, from P0's combined
signal.

**`collect(agentIds: string[], waitMs?: number)`** → the terminal reply per
agent. Optionally blocks up to `waitMs`. Without it the model burns turns
polling; with unbounded blocking one stuck agent hangs the parent. On timeout it
returns **partial results with per-agent status** — "three done, one working" is
the normal case, and treating it as an error would make the model discard good
work.

### Failure is per-agent

One task failing to spawn does not fail the batch. This matches the backend's
existing posture of distinct, named refusal reasons rather than a single opaque
error.

## Safety

### One approval per batch

`mcp__fleet__spawn` joins the gated tool set and rides the existing `canUseTool`
path — blocking for interactive turns, parked for watchdog turns, exactly like
infra mutations.

The task-list signature exists partly for this: the operator sees **all N tasks
in a single approval** and decides once. Gating per agent would mean twelve
dialogs for a twelve-way fan-out, which trains operators to click through — a
worse security outcome than one well-presented decision.

### Hard caps, enforced in Rhumb

Checked in the tool handler *before* any `mngr create` runs, so a model that
ignores its instructions still cannot exceed them. Defaults, each overridable by
environment variable:

| Cap | Default | Variable |
| --- | --- | --- |
| Max tasks per `spawn` call | 8 | `RHUMB_FLEET_MAX_PER_SPAWN` |
| Max concurrent live agents | 8 | `RHUMB_FLEET_MAX_CONCURRENT` |
| Max depth | 1 | `RHUMB_FLEET_MAX_DEPTH` |

The defaults are deliberately conservative: at ~90s per turn and one `mngr create`
each, eight concurrent agents is already a meaningful load on one box. Depth
defaults to 1 because P1 cannot exceed it by construction (see below); the cap
exists so P3 inherits a working mechanism rather than adding one.

Caps are validated at load, alongside the other eager config validation, so a
malformed value fails at boot rather than mid-turn.

### Recursion is structurally impossible in P1

A spawned agent is an mngr agent, and slice 1 established that mngr agents
**cannot receive in-process MCP servers** (`createSdkMcpServer` objects hold live
JS closures; the CLI's `--mcp-config` takes external servers only). A spawned
agent therefore has no `mcp__fleet__spawn` tool and physically cannot spawn.

The runaway-recursion risk does not exist until P3 makes the gate reachable out
of process. `depth` is still carried through the design so P3 retrofits nothing,
but in P1 the cap is enforced by construction rather than by a counter. A
limitation from slice 1 becomes a safety property here.

### Lineage is recorded, not inferred

`AgentRecord` gains `parentAgentId` and `depth`. A spawned agent also carries
`rhumb_parent_id` and `rhumb_depth` as mngr labels — the mechanism already proven
to round-trip through `list --format json`.

**Interaction to get right:** `RHUMB_*` variables are wildcard-blanked in the
spawn environment. Lineage must therefore travel as mngr **labels** and via
explicit `--env` injection that overrides the blanking — never by relying on
ambient inheritance, which the scrubber would silently erase.

### Audit

Spawn events extend the existing `appendInfraAudit` shape: the call, the
operator's decision, the principals created, the parent principal, and the depth.
"Which agent did this, spawned by whom, under whose authorization" must be
answerable from the log alone.

## Errors

| Condition | Behaviour |
| --- | --- |
| One task fails to spawn | Per-task failure in the result; batch succeeds |
| Cap exceeded | Error naming the cap and current usage (`"8 agents already live, limit 8"`) |
| Approval denied | Same shape as any denied gated tool; **zero** agents created |
| Unknown `agentId` | Distinct from a known principal that failed |
| `collect` hits `waitMs` | Partial results with per-agent status, not an error |

## Testing

Test-driven, following the existing vitest + dependency-injection style.

**Every safety test must be demonstrated to fail when its guard is removed.**
This is a direct lesson from slice 1: the credential regression test earned trust
only after the scrub was sabotaged two different ways and watched go red — and
the first sabotage tripped the *wrong* assertion, which alone would have left
false confidence. The implementation plan must require showing the red state for
caps, gating, and lineage, not merely a green one.

- **Unit** (fake backend and registry; no real mngr, tmux, or network): spawn,
  check, and collect happy paths; per-task failure isolation; every cap at its
  boundary (N passes, N+1 rejected); lineage written to the registry; and
  denied-approval creating **zero** agents rather than orphans.
- **P0**: terminal-`finish_reason` gating (a narration-then-answer transcript
  must return the answer); empty-but-terminal as a distinct outcome, never a
  silent `""`; status derivation across mngr states.
- **Live**, opt-in behind `RHUMB_LIVE_MNGR=1` alongside the existing suite: a
  real two-agent fleet spawn, both reaching terminal status, results collected,
  everything cleaned up. Two agents, not more — at ~90s each this is already slow.

The `AgentBackend` conformance suite does not apply: fleet consumes a backend, it
does not implement one.

## Risks

| Risk | Mitigation |
| --- | --- |
| Model spawns more agents than intended | Caps enforced in the handler before any create; one approval showing all N tasks |
| Cost runs away | Agent-count caps as proxy; token budgeting deferred (see below) |
| Lineage lost to env scrubbing | Labels + explicit `--env`, never ambient inheritance; covered by test |
| Fleet inherits slice 1's reply bugs | P0 is a prerequisite within this spec, not a follow-up |
| ~90s/turn makes fleets feel dead | Architectural fit (background, not interactive); `collect(waitMs)` so the model isn't forced to poll |
| Upstream mngr changes break assumptions | Phase 0 doc records each verified CLI behaviour as a re-verify-on-upgrade item |

## Deferred

- **Token/cost budgeting.** Metering mngr-spawned agents needs mngr's
  `claude_usage` plugin; agent-count is a serviceable proxy for P1.
- **P2 visibility and P3 multi-host**, per the decomposition above.
- Slice 1's remaining parked items (`sessions.json` polluted with mngr ids whose
  transcripts 404; no production callers for `list`/`stop`/`transcript`; the
  live suite's tight `waitForClaudePid` window; credential rotation not reaching
  live agents) — tracked in the slice 1 ledger and triaged into P2.
