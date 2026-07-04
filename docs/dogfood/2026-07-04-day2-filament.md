# Dogfood run — day-2: filament tracking on the live printer tracker

**Date:** 2026-07-04 · **Spec:** ../superpowers/specs/2026-07-04-day2-dogfood-filament-design.md
**Claim under test:** Rhumb can modify a tool it built — schema migration with live data, service redeploy, surface update — in one gated turn, driven from the client.

## Phase 0 — box update (on-ramp friction)

Task 1 updated the box from a non-git, tarball-deployed tree to current `main` (adce272-equivalent), 23 steps, ~13 min wall time (14:17:13–14:30:21). Headline findings:

- **No deployment mechanism exists in the repo.** `/root/rhumb` has no `.git` anywhere; the box was populated by copying locally-built tarballs (source built on Mac, tar'd, scp'd, extracted, then `npm ci && npm run build` run **on the box** — the real convention, confirmed by linux-x64 native binaries and root-owned `node_modules`/`dist` vs. `501:staff`-owned `src`). No `deploy.sh`, no Makefile target, nothing derivable from the repo. This is the single biggest on-ramp friction finding.
- **SSH known_hosts gap:** the Tailscale hostname (`micropx-pve.tail731306.ts.net`) wasn't pre-registered in `~/.ssh/known_hosts` even though the same host key was already trusted under its IP addresses. Fixed by appending a hostname-keyed line after verifying byte-identical key via `ssh-keyscan`.
- **RHUMB_ALLOWED_USERS env drift:** after rebuilding+restarting on the updated `main` (post PR #21 tailnet-identity work), both hosts crash-looped with `RHUMB_ALLOWED_USERS is required`. Predicted by the brief; fixed by appending the user's own existing value (`fcomposites@github`, copied verbatim from `/root/rhumb-pr21.env`) to `/root/rhumb.env`.
- **Stale plan assumption — health check drift:** the brief expected `dashboard / → 200`; post-identity the dashboard fails closed and returns 403 without a Tailscale identity header on a bare loopback curl. Correct check is `/healthz → {"ok":true}` on both hosts, which passes.
- **Serve repoint pending user authorization:** `tailscale serve` on the box still routes the tailnet HTTPS origin to the old pr21 stack (9787/9788); the updated stack (8787/8788) is healthy but loopback-only until serve is repointed — session's permission classifier deferred this live-ingress change to the user. Not done as part of Task 1 or this task.

## Phase 1 — baseline

**$DB (redacted):** host=192.168.1.91, db=printers, user=printers (postgres, mode read-write; datasource id `printers`)

### Table counts + schema (via agent-host's `pg`, read-only SELECT/information_schema only)

| table | rows | columns |
|---|---|---|
| `print_jobs` | 0 | id(integer), printer_id(integer), filename(text), state(text), started_at(timestamptz), finished_at(timestamptz), filament_used(double precision), total_layer(integer), current_layer(integer), print_duration(double precision), progress(double precision), created_at(timestamptz) |
| `printer_status` | 2 | printer_id(integer), printer_name(text), base_url(text), printer_state(text), last_seen(timestamptz), sampled_at(timestamptz), sample_state(text), bed_temp(double precision), bed_target(double precision), nozzle_temp(double precision), nozzle_target(double precision), progress(double precision), current_layer(integer), total_layer(integer), filament_used(double precision), print_duration(double precision), active_job_id(integer), active_filename(text), active_started_at(timestamptz) |
| `printers` | 2 | id(integer), name(text), base_url(text), state(text), last_seen(timestamptz), created_at(timestamptz) |
| `recent_jobs` | 0 | id(integer), printer_id(integer), printer_name(text), filename(text), state(text), started_at(timestamptz), finished_at(timestamptz), filament_used(double precision), total_layer(integer), current_layer(integer), progress(double precision), print_duration(double precision) |
| `recent_telemetry` | 960 | id(bigint), printer_id(integer), printer_name(text), sampled_at(timestamptz), state(text), bed_temp(double precision), nozzle_temp(double precision), progress(double precision), current_layer(integer), total_layer(integer), filament_used(double precision) |
| `telemetry_samples` | 32338 | id(bigint), printer_id(integer), job_id(integer), sampled_at(timestamptz), state(text), bed_temp(double precision), bed_target(double precision), nozzle_temp(double precision), nozzle_target(double precision), progress(double precision), current_layer(integer), total_layer(integer), filament_used(double precision), print_duration(double precision) |

Note: 6 tables present (not the ~3 anticipated by the brief) — `printers`/`printer_status` look like base tables, `recent_jobs`/`recent_telemetry` appear to be views/rollups over `print_jobs`/`telemetry_samples`. `telemetry_samples` (32,338 rows) is the primary data-preservation reference for later tasks; `print_jobs`/`recent_jobs` are currently empty (no job history recorded yet).

### Poller service

- Service entry (`$WS/services.json`, id `printer-poller`): containerId **105**, host **192.168.1.95** (`$CTR_IP`), port 8080, basePath `/services/printer-poller`, status `healthy` (as recorded), created 2026-07-02T00:55:09.836Z.
- **Discrepancy noted:** the ontology file `system/service-printer-poller.md` records `host: 192.168.1.238`, which does not respond (curl to `.238:8080` times out / connection fails). `services.json`'s `192.168.1.95` is the live, reachable address — confirmed authoritative. Likely ontology staleness from creation-time vs. current container IP; flagged as a finding, not corrected (read-only task).
- **$POLLER_HEALTH = `http://192.168.1.95:8080/health`** (note: NOT `.../services/printer-poller/health`, which 404s — the service's own basePath prefix is for the dashboard's proxy layer, not the container's direct HTTP surface).
- Response: `{"ok":true,"printers":["K2Plus-FE91","K2Plus-Right"],"lastTick":"2026-07-04T18:38:17.041Z"}`

### Surface + dashboard status

- `curl http://127.0.0.1:8788/surfaces/printer-tracker/` → **403** (expected per Phase 0 finding: post-identity dashboard fails closed without a Tailscale identity header; a bare loopback curl carries none — this is NOT a regression, matches the `/` → 403 behavior already recorded in Task 1).
- `curl http://127.0.0.1:8788/` → 403 (consistent).
- `curl http://127.0.0.1:8788/healthz` → `{"ok":true}`, 200.

### Ontology entries (`$WS/ontology`, grep -ril printer)

```
domain/printer-k2plus-fe91.md
domain/printer-k2plus-right.md
domain/print-jobs.md
system/dashboard-printer-tracker.md
system/datasource-printers.md
system/service-printer-poller.md
```

All four expected system entries present: `datasource-printers`, `service-printer-poller`, `dashboard-printer-tracker`, and container info nested under `service-printer-poller.md`'s `runs-on [[container-105]]` relationship (container-105.md itself has no host/IP fields, just an id/relationship stub).

## Phase 2 — the turn (live log)
<!-- timestamped observations; every friction point tagged F# -->

## Findings
<!-- F1..Fn, severity, action -->

## Phase 3 — ground-truth verification
<!-- pass/fail per spec criterion 1–5 -->

## Outcome
