# Dogfood run — write-back / CRUD trust-gate (filament spool inventory)

**Date:** 2026-07-06 · **Spec:** ../superpowers/specs/2026-07-06-crud-trust-dogfood-design.md
**Box code:** merged main (cd1266e) — no redeploy this run.
**Claim under test:** the write-back loop (provision → write → gate → trust → audit) works end-to-end live, and the trust model's real (coarse) behavior is documented.

## Phase 0/1 — client ready + baseline

Read-only snapshot taken via SSH against `micropx-pve.tail731306.ts.net` (WS=`/root/rhumbr-workspace`, REPO_DIR=`/root/rhumb`), before any live CRUD/trust turn.

**data-sources.json** — one existing source:
- id `printers`, type `postgres`, mode `read-write` (connection string password redacted)

**data-trust.json** — absent. Trust store starts clean; any file/content appearing after the build turn is new.

**data-audit.jsonl** — absent. Baseline line count: 0. Any lines appearing after the build turn are new writes to count against.

**services.json** — one existing service:
- id `printer-poller`

**ontology** — pre-existing entries (context, not touched by this baseline):
- `ontology/domain/`: `printer-k2plus-fe91.md`, `printer-k2plus-right.md`, `print-jobs.md`
- `ontology/system/`: `container-105.md`, `dashboard-printer-tracker.md`, `datasource-printers.md`, `service-printer-poller.md`

## Phase 2 — the build turn (live log)
## Phase 3 — the write session (trust ladder + adversarial probes)
## Findings
## Phase 4 — ground-truth verification
## Outcome
