# Read-only watchdog — the box tells you before you tell it

**Date:** 2026-07-13
**Status:** approved
**Prior art:** operate-loop direction (user-endorsed: scheduled sessions → async approvals → notifications; this is slice 1), node-facts + ddl-facts (the ground truth this reconciles against), F8/F16 dogfoods (drift the operator had to find by hand).

## Problem

Every drift finding so far (crash-looping orphan, stale ontology IP, half-dead
poller) was caught by the operator or a run log — never by the platform. The
substrate to do better now exists: a truthful self-updating map, health
status, DDL history, an audit trail. What's missing is anything that *looks*
at it on a schedule.

## Decision (user-approved slice 1 of the operate loop)

A **read-only watchdog**: agent-host runs a standing reconcile-and-report
prompt on a fixed interval, as a normal session, with mutation made
*structurally impossible* — not requested in prose. Async approvals and a
real notification path are later slices; this one must not be able to block
or act, only observe and write a report.

## Design

### Scheduler (`agent-host/src/watchdog.ts`)

- `createWatchdog({ intervalMs, runTurn, log? })` → `{ start, stop, tick }`.
- Plain `setInterval` (`unref`'d — never holds the process); `tick()`:
  - **Overlap guard:** if a run is still in flight, the tick is skipped
    (returns `"skipped"`) — a slow model turn must not stack turns.
  - Errors are caught and logged, never thrown into the timer.
- Config: `RHUMB_WATCHDOG_MINUTES` (positive integer → interval; unset/invalid
  → watchdog off). No cron dependency — an interval is enough for slice 1
  (YAGNI; cron can come with the scheduler's later growth).

### Read-only enforcement — structural, not rhetorical

A **second `SessionManager`** sharing the same query fn but with its own
`extraOptions`: the base session options plus
`disallowedTools = watchdogDisallowedTools(GATED_TOOLS)` =
`["AskUserQuestion", "Bash", "Write", "Edit", "NotebookEdit"]` + all 11
`mcp__infra__*` gated tools by name. Two properties matter:

1. **Gated tools are disallowed, not gated.** A gated call would enqueue and
   block until an operator resolves it — with the client closed, forever.
   The watchdog must be unable to *reach* the gate.
2. **What remains is read-only by construction:** `Read`/`Grep`/`Glob`,
   `WebFetch` (health endpoints), the 4 ungated infra read tools
   (`list_vms`, `vm_status`, `list_services`, `service_status`), and the
   ontology tools (`sync` writes only the projector's own bookkeeping — it
   is the reconcile primitive, not a mutation of operated state).

### The standing prompt (`WATCHDOG_PROMPT` in watchdog.ts)

Reconcile the ontology against live state: sync + query the map; check each
service via `service_status` and its health endpoint; compare
hosts/containers/node placement against the map; note recent DDL activity on
data sources. Report-only, terse, lead with anything unhealthy or drifted;
state "all healthy" explicitly when true.

### Where the report lands

It's a normal session: on the session event, the turn registers via
`sessions.upsertFromTurn(sessionId, "Watchdog — <YYYY-MM-DD HH:mm>")` (the
title-from-prompt rule makes the label the title). The Sessions panel lists
it; the transcript is the report. That *is* the slice-1 notification —
zero new client code. Dedicated inbox/push arrives with async approvals.

### Wiring

- `loadConfig` gains `watchdogMinutes: number | null`.
- `buildApp` constructs the watchdog when configured and attaches it as
  `app.locals.watchdog` (no signature change for existing tests/callers);
  **`main()` starts it** — tests exercising `buildApp` never start timers.

## Out of scope (later slices)

- Async approvals / any mutating remediation.
- Push notifications, unread badges for externally-created sessions, inbox UI.
- Cron expressions, per-check configuration, multiple standing prompts.

## Failure modes considered

- Model turn hangs → overlap guard skips ticks; no stacking. (The SDK's own
  turn lifecycle bounds the hang; the guard bounds the damage.)
- Watchdog turn errors (auth expiry, SDK failure) → logged, next tick runs.
- Operator never opens the client → reports accumulate as sessions; harmless.
- Config absent → feature entirely off; zero behavior change.

## Testing

- `watchdog.test.ts` (fake timers): interval scheduling; overlap skip; error
  swallowed + logged; stop clears; `watchdogDisallowedTools` contains
  Bash/Write/Edit/every gated infra tool and none of the ontology/read tools.
- `config.test.ts`: `RHUMB_WATCHDOG_MINUTES` parse (valid, invalid, absent).
- `index.smoke.test.ts`: configured app exposes `app.locals.watchdog`;
  `tick()` drives the injected query with the restricted `disallowedTools`
  and registers the "Watchdog — …" session title.
- Live dogfood (post-merge): stop the poller container with the client
  closed; next tick's session must lead with the unhealthy service.
