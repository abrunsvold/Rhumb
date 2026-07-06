# Dogfood run — write-back / CRUD trust-gate (filament spool inventory)

**Date:** 2026-07-06 · **Status:** approved design, pending run
**Prior art:** [docs/dogfood/2026-07-05-migration.md](../../dogfood/2026-07-05-migration.md) (migration run; F17 = DDL bypassed the gate)

## Purpose

The write-back stack — dashboard-host `/data/*` structured-op writes, the pending-queue, persisted trust (`data-trust.json`), the audit log (`data-audit.jsonl`), and the client `ConfirmationDialog`'s data branch — is well covered by unit tests but has **never run end-to-end live**: no real provisioned DB, no real agent-built surface writing back, no human clicking a data-write approval. This run exercises the whole loop with a genuinely useful new tool and deliberately stress-tests the trust model's coarseness.

Two facts from the code map shape the run:
- **Trust is per-(source, surface) only** — approving once with "trust this surface" auto-executes *every* future write from that surface to that source: any table, any op kind, including DELETE. No per-table / per-op / time scoping.
- **DDL was never gated** (F17 confirmed): `DataOp` covers only `select|insert|update|delete`; `CREATE/ALTER/DROP TABLE` have no branch in `/data/*` and are not `GatedTool`s — the migration turn's `ALTER` via Bash wasn't a bypass, it was an ungated category by omission.

**Success bar:** the write-back loop works end-to-end live AND the trust model's real behavior (especially its coarseness) is documented with pasted evidence. Findings — not this plan — decide whether trust needs finer scoping or DDL needs a gate.

## The tool

Given to the build agent verbatim, from the client chat:

> "Track my filament spools — material, color, weight remaining; let me add spools and update remaining weight from the dashboard."

A new tool (not the printer tracker): its own agent-provisioned Postgres DB, a spool table, and a surface whose UI writes back through `/data/*`. Thematically real for a homelab 3D-printing setup, and it exercises provisioning + write-back + trust end-to-end.

## Driving

Both phases from the Tauri client (freshly rebuilt from merged main, now with markdown rendering). This doubles as live validation of the client's `ConfirmationDialog` **data** branch — which has never rendered live, only been unit-tested — and a second look at the F8 send loop under a multi-approval sequence (n>1 this time).

## Run protocol

### Phase 0 — client ready, box current

The box already runs merged-main server code (confirmed healthy this session: both `/healthz` OK, one poller container 105, telemetry climbing); dashboard-host `/data/*` is already live, so **no redeploy is needed**. Relaunch the rebuilt client and connect (manual URL is fine — F14 GUI autodiscovery is a known open chip). Confirm the client build carries the merged tip.

### Phase 1 — baseline

Snapshot before the build (the diff target): `data-sources.json` (expect only `printers`), `data-trust.json` and `data-audit.jsonl` (expect empty/absent — trust starts clean, which is the point), `services.json`, and the ontology. Record so "a new read-write source got provisioned" and "trust got persisted" are objectively checkable.

### Phase 2 — the build turn (client chat, observe-don't-rescue)

Send the verbatim prompt. Approve gated **infra** actions (the `provision_database` hits the *infra* pending queue in agent-host) through the client dialog. Watch-list, each logged with a timestamp:
- Does the agent use `provision_database`, and does the new source auto-register as `read-write`?
- Does the surface issue structured `/data/*` write ops (insert/update), not raw SQL?
- **F17 re-observed:** how does the schema DDL (`CREATE TABLE`) happen — ungated Bash again, or otherwise?
- Client send loop under a multi-approval build (F8, n>1); transcript follow (F9).

### Phase 3 — the write session (surface in client canvas + ConfirmationDialog data branch)

The heart of the run. Walk the **trust ladder**, logging for each write what the dialog showed, the operator action, and whether the row reached the DB:
1. Add a spool → the write enqueues → **approve without trust** → executes.
2. Add another spool → enqueues → **approve WITH "trust this surface"** → executes.
3. Update a spool's remaining weight → **executes silently** (trusted, no dialog).

Then **adversarial probes** (the sharp part):
- **Coarseness:** issue a DELETE from the trusted surface — does it also skip the gate? Record the result regardless of direction (the trust model telling the truth about its own scope).
- **Self-approve guard:** attempt a `/data/*` write / pending-resolve without the `Sec-Rhumb-Control` shell header (e.g. from the surface's own page JS or a plain curl) — expect 403 (the surface cannot bless its own write).
- **Identifier whitelist:** attempt a write with a malformed identifier (e.g. a table/column name with a quote or space) — expect rejection by `ident()`'s whitelist, not a SQL error reaching the DB.

### Phase 4 — ground-truth verification

Read-only against the box after the session. Pass requires:
1. **Provisioning:** a new `read-write` data source in `data-sources.json`; its DB + spool table exist in Postgres with the expected columns.
2. **Gated write executed:** the first approved (untrusted) write landed a real row; `data-audit.jsonl` has a `decision:"executed"` entry for it.
3. **Trust persisted + honored:** after the trust approval, `data-trust.json` contains the `(source, surface)` pair, and the subsequent update executed with **no** pending entry (audit shows executed; the queue was never hit for it).
4. **Coarseness finding:** whether the post-trust DELETE skipped the gate — recorded as a finding either way.
5. **Guards held:** the self-approve probe got 403; the malformed-identifier probe was rejected by the whitelist (no malformed SQL reached the DB).
6. **Audit integrity:** every write in the session has a matching audit line (executed/denied/error) — `data-audit.jsonl` is as trustworthy as `infra-audit.jsonl` was in day-2.
7. **F17 re-observed:** how DDL happened this run, carried as a finding (gate it, or document as intentionally agent-autonomous).

### Findings

Written to `docs/dogfood/2026-07-06-crud-trust.md`, F-numbering continues from F19. Same format as prior runs: setup reality → build turn → write session → F-numbered findings with severity → outcome with per-criterion verdict → ranked roadmap. Positive-findings block for what the write-back stack proved live.

## Structure & scope

Subagent-driven, phase-per-agent with review gates; the write-session and verification get adversarial evidence checks (the discipline that has caught a false-success in every prior run). GUI driven autonomously via computer-use.

**Out of scope:** fixing anything found (next cycle); the F14 GUI-discovery chip (task_88be5401); multi-surface trust interactions; any change to the trust model itself (this run *characterizes* it).
