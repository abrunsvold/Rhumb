# DDL facts — surface schema changes in the System map (F17: document + surface)

**Date:** 2026-07-12
**Status:** approved
**Prior art:** F17 (CRUD dogfood: DDL via the agent's own Bash bypasses the DML-only `/data` gate; reproduced in the migration dogfood), `2026-07-07-ddl-audit-design.md` (the superuser-owned `_rhumb.ddl_audit` event-trigger backstop), repo audit ("insurance with no claims adjuster": nothing reads the audit table), node-facts design (the refresher/file/projector pattern this reuses).

## Decision (user-approved)

**Surface now, gate later.** Schema changes are legitimate core workflow (the
migration dogfood depends on them), and today the agent only runs during
operator-initiated turns — so F17 closes as *document + surface*: every DDL
statement is already recorded tamper-proof per database; this makes the record
**visible** in the System map, and SECURITY.md states the posture. A hard gate
(owner roles without CREATE + a gated `apply_ddl` tool) is deliberately
deferred to the operate-loop work, where unattended sessions change the
calculus.

## Server side (agent-host)

### `ddl-facts.json` (file-as-contract, same pattern as node-facts)

```json
{
  "fetchedAt": "2026-07-12T…",
  "sources": {
    "printers": { "installed": false },
    "sales": {
      "installed": true, "count7d": 3,
      "lastTs": "2026-07-06T…", "lastTag": "CREATE TABLE",
      "lastObject": "public.filament_spools", "lastActor": "spools_owner"
    }
  }
}
```

- **Refresher** (`infra/ddlFacts.ts`): for each entry in `data-sources.json`,
  derive the database name from the source's connection-string URL path, then
  query THAT database **with the admin credentials** (`connStringForDb` on
  `RHUMB_PG_ADMIN` — the audit table is deliberately unreadable by owner
  roles):
  1. `SELECT to_regclass('_rhumb.ddl_audit')` — null ⇒ `installed: false`
     (databases provisioned before the DDL-audit feature exist live; say so
     honestly instead of erroring).
  2. Latest row (`ts, actor, command_tag, object_identity`) + 7-day count.
  - Per-source degradation: a query error or unparsable connection string
    omits that source from the file (absent ≠ not-installed).
- **Query helper:** `AdminExecutor.exec` is execute-only, so `pgAdmin.ts`
  gains `createAdminQuery(connString): (sql) => Promise<rows>` — a
  short-lived single-connection pool per call (refresh runs on panel open,
  not in a hot path).
- **Triggers & gating:** composed with the node-facts refresher into one
  `refreshExternal` — awaited in `GET /ontology` (via `Promise.allSettled`,
  each degrades independently), fire-and-forget on infra `onMutate`. Built
  iff `RHUMB_PG_ADMIN` is set (independent of the Proxmox half).

### Projector

`SyncDeps.readDdlFacts: () => DdlFacts | null`. Datasource nodes gain props:
- installed + history: `lastDdl: "CREATE TABLE public.filament_spools by spools_owner @ <ts>"`, `ddl7d: "3"`, `ddlAsOf: <fetchedAt>`
- installed, no rows yet: just `ddl7d: "0"` + `ddlAsOf`
- not installed: `ddlAudit: "not installed (pre-audit database)"`
- source absent from facts: no ddl props (unchanged node).

## Client

Nothing: datasource detail cards already render arbitrary props.

## SECURITY.md

New subsection stating the DDL posture: the `/data` gate covers DML only; DDL
executed through the agent's own tools runs ungated **during
operator-initiated turns**, is recorded per-database by superuser-owned event
triggers the owner role cannot tamper with, and is surfaced on the System
map; a hard DDL gate is planned alongside unattended/scheduled sessions.

## Out of scope

- The hard gate (owner-role CREATE revocation + gated `apply_ddl`).
- Backfilling `_rhumb` into pre-audit databases (visible as "not installed";
  backfill is an operator/agent action, not a read-path side effect).
- Full schema-change history browsing (a surface's job if ever needed).

## Testing

- `ddl-facts.test.ts`: refresher against fake `readSources`/`queryDb` —
  installed source with rows; `to_regclass` null ⇒ installed:false; query
  error ⇒ source omitted; bad connection string ⇒ skipped; file written +
  `readDdlFactsFile` round-trip.
- `ontology-projector.test.ts`: the four datasource prop cases above.
- Router refresh composition is covered by the existing refresh-ordering and
  refresh-rejection tests (refresh is an opaque function).
