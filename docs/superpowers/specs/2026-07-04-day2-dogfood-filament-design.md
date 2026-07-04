# Day-2 dogfood — filament tracking on the live printer tracker

**Date:** 2026-07-04 · **Status:** approved design, pending run
**Prior art:** [docs/dogfood/2026-07-01-printer-tracker.md](../../dogfood/2026-07-01-printer-tracker.md) (greenfield run; F3/F4/F6 fixed and live-verified)

## Purpose

The first dogfood run proved the greenfield happy path: one gated turn built a real tool (poller → provisioned Postgres → surface → ontology) and left it running. Nothing has tested **day-2 operations** — modifying a tool the platform already built, live, without losing data. This run does exactly that, and its findings (not this document) set the next roadmap items.

Claim under test: *Rhumb can change what it built* — schema migration on a DB with live rows, code change to a running service, redeploy, surface update — in one gated turn, driven from the real client.

## The compound change

One realistic ask, given to the build agent roughly verbatim:

> "The printer tracker should track filament usage. Add per-job filament used (Moonraker exposes `print_stats.filament_used`), keep it in job history, and show it on the dashboard."

Why this change: Moonraker already exposes the field, and it is the smallest realistic ask that forces all three layers to change at once —

- **DB:** `ALTER TABLE` (or equivalent) on the jobs table of a database holding live telemetry (~800+ rows at last count, climbing).
- **Service:** poller code change + redeploy of a running systemd service in LXC 105.
- **Surface:** dashboard update to show the new field.

Coordination/sequencing failures (deploying the new poller before the migration, wiping data on redeploy, surface reading a column that doesn't exist yet) should surface naturally rather than being staged.

Alternatives considered and rejected for this round: job-history pruning (DB-only, no service redeploy), print-completion alerts (adds a notification channel — new scope, not day-2 scope).

## Run protocol

### Phase 0 — update the box

The box (`micropx-pve.tail731306.ts.net`) runs the PR #21 stack; main is two merges ahead (#22 platform shell + first-class sessions — includes agent-host session-index backfill; #23 follow-ups). Bring the box to current main before the run.

This phase is deliberately part of the dogfood: the first run flagged "redeploy after env change is ~15 manual steps" as an on-ramp roadmap signal. Count and time the steps again; that friction is a **finding**, not overhead.

### Phase 1 — baseline snapshot

Before the turn, record:

- Telemetry and job row counts (direct DB query).
- Poller health endpoint output.
- Surface HTTP status.
- Ontology entries for the tracker (`datasource-printers`, `service-printer-poller`, `container-105`, `dashboard-printer-tracker`).

This makes "no data lost" objectively checkable afterward.

### Phase 2 — the turn

- Driven from the **Tauri client**: connect over tailnet identity, run the compound ask as one goal-directed session in a chat tab.
- Operator confirmations answered through the client's **pending-action UI** — not curl. (This incidentally smoke-tests PR #22/#23 against a real gated build; if the client itself blocks progress, fall back to raw HTTP for that step and record the client failure as a finding.)
- House rule: **observe, don't rescue.** Let the agent self-recover; log every friction point with severity, as F-numbered findings.

### Phase 3 — ground-truth verification

Pass requires all of:

1. **Data preserved** — pre-existing telemetry/job rows intact: post-run counts ≥ baseline, with growth consistent with poll cadence; no truncation/recreation of tables holding baseline data.
2. **Service healthy, hands-off** — poller redeployed and back to `healthy` with no manual surgery (no SSH fixes, no manual restarts).
3. **New field live** — filament column exists and is populated by the poller. Both printers are expected idle, so `filament_used` legitimately reads 0; if a real print runs during the window we verify live values, otherwise verifying the plumbing at 0 passes and is noted.
4. **Surface renders the field** — dashboard shows filament usage, HTTP 200.
5. **Ontology consistent** — existing entries intact; any new/changed entries correctly linked.

## Watch-list (likely breakage going in)

- **No migration story exists.** The agent must improvise the `ALTER TABLE`. Does it back up first? Does it check existing schema before writing?
- **Redeploy of an existing service.** `spawn_service` has only ever been exercised on fresh spawns. Does the deploy path handle "service already exists / container already exists," or does it try to re-provision?
- **Pending-action flow under a real multi-confirmation build** in the client — ordering, refresh, and error surfacing when several gated actions queue up.
- **`AskUserQuestion` fallback (F1 from run 1):** with the client in the loop, does the agent still burn turns on unanswerable prompts, or does the session channel change this?

## Findings capture

- Written to `docs/dogfood/2026-07-04-day2-filament.md` (dated to the actual run day), same format as the first run: setup reality, the turn, F-numbered findings with severity, outcome with ground-truth verification, fixes landed if any.
- Explicit rule carried over: **the findings drive the roadmap.** Whatever breaks worst becomes the next fix cycle, re-verified live before the run is called closed.

## Out of scope

- Write-back/CRUD trust-gate testing (separate future dogfood).
- New greenfield tools, non-Node runtimes.
- Client feature work beyond recording findings (client bugs found here get filed, not fixed mid-run).
- Decommission/teardown lifecycle (candidate for the round after).
