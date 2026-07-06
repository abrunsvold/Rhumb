# Dogfood run — novel-field migration + live fix-stack validation

**Date:** 2026-07-05 · **Spec:** ../superpowers/specs/2026-07-05-migration-dogfood-design.md
**Branch under test:** fix/client-chat-discovery @ 2f0f179 (PR #25+#26+#28)
**Headline claim:** redeploy_service now cleanly cuts over a real change (the day-2 orphaned-container BLOCKER, fixed).

## Phase 0 — fix-stack deploy (on-ramp friction)
## Phase 1 — baseline

### Datasource ($DB, redacted)

`$DB` = `printers` datasource, host `192.168.1.91:5432`, db `printers`, user `printers` (password redacted, not persisted).

### Schema + row counts (diff target)

| table | rows | columns (name:type) |
|---|---|---|
| `print_jobs` | 0 | id:integer, printer_id:integer, filename:text, state:text, started_at:timestamptz, finished_at:timestamptz, filament_used:double precision, total_layer:integer, current_layer:integer, print_duration:double precision, progress:double precision, created_at:timestamptz |
| `printer_status` | 2 | printer_id:integer, printer_name:text, base_url:text, printer_state:text, last_seen:timestamptz, sampled_at:timestamptz, sample_state:text, bed_temp:double precision, bed_target:double precision, nozzle_temp:double precision, nozzle_target:double precision, progress:double precision, current_layer:integer, total_layer:integer, filament_used:double precision, print_duration:double precision, active_job_id:integer, active_filename:text, active_started_at:timestamptz |
| `printers` | 2 | id:integer, name:text, base_url:text, state:text, last_seen:timestamptz, created_at:timestamptz |
| `recent_jobs` | 0 | id:integer, printer_id:integer, printer_name:text, filename:text, state:text, started_at:timestamptz, finished_at:timestamptz, filament_used:double precision, total_layer:integer, current_layer:integer, progress:double precision, print_duration:double precision |
| `recent_telemetry` | 960 | id:bigint, printer_id:integer, printer_name:text, sampled_at:timestamptz, state:text, bed_temp:double precision, nozzle_temp:double precision, progress:double precision, current_layer:integer, total_layer:integer, filament_used:double precision |
| `telemetry_samples` | 47248 | id:bigint, printer_id:integer, job_id:integer, sampled_at:timestamptz, state:text, bed_temp:double precision, bed_target:double precision, nozzle_temp:double precision, nozzle_target:double precision, progress:double precision, current_layer:integer, total_layer:integer, filament_used:double precision, print_duration:double precision |

6 tables total in `public` schema. Full raw output logged in `.superpowers/sdd/mig-runsheet.md`.

### Service baseline

- `$POLLER_CTR` = `106` (matches expectation)
- `$POLLER_IP` = `192.168.1.83`
- `$POLLER_DEPLOYID` = `20260704212359-d25440` (matches expectation)
- status: `healthy`, port `8080`, basePath `/services/printer-poller`

### Ontology node baseline (F16 diff target)

`ontology/system/service-printer-poller.md` (managed: system) currently reads:

```yaml
host: 192.168.1.238
port: 8080
status: healthy
```
```
Relationships:
- runs-on [[container-105]]
- created-by [[agent]]
```

**Drift already present before any migration turn:** the ontology service node references `container-105` / host `192.168.1.238`, while `services.json` (ground truth) has the poller on **container 106** / host `192.168.1.83`. `ontology/system/container-105.md` exists; there is no `container-106.md` node. This is a pre-existing staleness, not something Phase 2 will introduce — it's the exact shape of drift F16 is meant to catch, so it's the diff baseline: after the coming redeploy turn, verification should check whether the ontology gets corrected to reference 106, or whether it remains stuck on the now-doubly-stale 105.

Other ontology files present: `dashboard-printer-tracker.md`, `datasource-printers.md` (system); `printer-k2plus-fe91.md`, `printer-k2plus-right.md`, `print-jobs.md` (domain).

### Surface baseline

`http://127.0.0.1:8788/surfaces/printer-tracker/` → `403 {"error":"forbidden"}` (also 403 on 8787). Consistent across both dashboard ports — read as auth-gated by design, not a broken surface; recorded as-is for before/after comparison.

## Phase 2 — the turn (live log)
## Findings
## Phase 3 — ground-truth verification
## Outcome
