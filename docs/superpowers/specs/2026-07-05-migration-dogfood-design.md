# Dogfood run — novel-field schema migration + live fix-stack validation

**Date:** 2026-07-05 · **Status:** approved design, pending run
**Prior art:** [docs/dogfood/2026-07-04-day2-filament.md](../../dogfood/2026-07-04-day2-filament.md) (day-2 run + its F11 capstone)

## Purpose

Two claims, one run.

1. **The day-2 claim, retried honestly.** Day-2 asked the platform to change a tool it built; the agent found the feature already existed and dodged the schema migration. This run forces a *genuinely new* field so the migration dimension is actually exercised: a live `ALTER` + a real poller code change + a service redeploy.
2. **Live validation of the unmerged fix stack.** The branch tip (`2f0f179`) carries the entire stack — PR #25 (F11/F12 redeploy), PR #26 (platform sweep: F16 auto-sync, atomic writes, ssh sanitization, F7 steering), PR #28 (client batch: F8/F9/F14). Deploying it and driving one real change proves the fixes against reality *before* merge — especially F11, whose absence orphaned container 106 on day-2.

If Phase-3 criterion 1 passes, the day-2 BLOCKER is fixed live and the stack is validated for merge. If it regresses, that is the top finding and merge waits.

## The change

Given to the build agent verbatim, from the fixed Tauri client:

> "Track the hottest nozzle and bed temperature reached during each print job, and show it on the dashboard."

Why this change: Moonraker exposes `extruder`/`heater_bed` temperatures every poll, so the field is populatable, and it forces all three layers — a new column pair on the jobs table, **genuinely new poller logic** (a running max updated each poll, not a passthrough), a redeploy, and a surface update.

**Known limitation, stated honestly.** The natural home for per-job max-temps is the `print_jobs` table, which is empty (both printers idle since day-2). So the `ALTER` lands on a zero-row table — not a stress test of migrating data-bearing rows. The real live-data preservation test here is the **32k-row telemetry table surviving the redeploy** in the same database. A data-bearing `ALTER` would need rows in `print_jobs`, which needs a real print; none is available. This is the same plumbing-at-idle honesty as day-2's filament-at-0.

## Run protocol

### Phase 0 — deploy the fix stack

Ship branch tip `2f0f179` to the box (`micropx-pve.tail731306.ts.net`): build `agent-host` + `dashboard-host` locally, tarball-deploy per the established convention (backup `/root/rhumb` first), restart `rhumbr-agent.service` / `rhumbr-dashboard.service`, health-check. Rebuild the Tauri client from the branch.

Confirm the new capabilities are live before the turn:
- `redeploy_service` present in the agent's infra tool set.
- SSE heartbeat emitted: a turn/session stream carries `:keepalive` frames.
- Discovery diagnostic shape returns from the client's connect path.

This phase is itself a test: it re-exercises on-ramp friction (F15) and runs the deploy under the new atomic-write + ssh-sanitized code. Time/step-count it.

### Phase 1 — baseline snapshot

Record (the diff target): full column schema of all 6 tables + row counts (telemetry ≥ ~32k, `print_jobs` 0); poller container id + deployId (currently 106 / `20260704212359-d25440`) from `services.json`; ontology entries for the tracker; surface HTTP status.

### Phase 2 — the turn (driven from the fixed client)

- Connect the client (also validates F14 discovery + manual-entry path), open a chat tab, send the verbatim prompt.
- **Observe, don't rescue.** Approve gated actions through the client's pending-action UI. No manual box/DB commands until the turn is declared over.
- Watch-list (log each with a timestamp): does the agent use `redeploy_service` (not `spawn_service`)? does the redeploy cut over cleanly? does the client send loop survive the multi-approval sequence without wedging (F8)? does the transcript follow the live edge (F9)? does the agent avoid an unanswerable `AskUserQuestion` (F7)?

### Phase 3 — ground-truth verification

Read-only after the turn. Pass requires all of:

1. **Clean cutover (headline, F11 live proof).** `pct list` shows exactly ONE poller container; registry points at a NEW containerId + NEW deployId with `updatedAt` set; the OLD container is gone; three-way provenance matches (container `.rhumb-deploy.json` = unit `RHUMB_DEPLOY_ID` = registry deployId); the new unit's restart count is low (no crash loop). An orphaned container or an unmoved registry = the fix regressed.
2. **Migration landed.** New max-nozzle / max-bed columns exist on the jobs table; schema otherwise column-identical to baseline; live poller code contains the running-max logic.
3. **Live data preserved.** All 6 baseline tables present; telemetry count ≥ baseline and climbing (32k rows survived the redeploy); no table truncated.
4. **F16 auto-sync, no manual call.** The ontology container/service node reflects the NEW container id/IP without anyone calling `ontology_sync` — the platform-sweep hook fired it on the successful mutation. Diff against the Phase-1 ontology.
5. **F7 / F8 / F9 held.** From the Phase-2 log: no wasted `AskUserQuestion`; client send never wedged across the approvals; transcript followed the live edge.
6. **Surface renders** the new field; HTTP 200.

Values populate at 0/NULL (printers idle) — plumbing-at-idle passes, noted.

### Findings

Written to `docs/dogfood/2026-07-05-migration.md` (dated to the run), continuing F-numbering from F16, same format as prior runs: setup reality → the turn → F-numbered findings with severity → outcome with per-criterion verdict → ranked roadmap. Explicit success bar restated: criterion 1 pass = day-2 BLOCKER fixed live + stack validated for merge.

## Out of scope

- Merging the PRs (this run validates them; the merge decision is the operator's afterward).
- The write-back / CRUD trust-gate dogfood (the run after this).
- F15 beyond re-recording its friction during Phase 0.
- A data-bearing `ALTER` (no rows available in `print_jobs` while printers are idle).
