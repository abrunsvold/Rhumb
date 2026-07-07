# DDL audit via Postgres event triggers (F17)

**Date:** 2026-07-07 · **Status:** approved design
**Fixes:** F17 (from [migration](../../dogfood/2026-07-05-migration.md) + [CRUD](../../dogfood/2026-07-06-crud-trust.md) dogfoods)

## Problem

Schema changes (`CREATE`/`ALTER`/`DROP TABLE`, indexes, etc.) run **ungated and unrecorded**. The `/data/*` write-back gate is DML-only (`select|insert|update|delete`), and provisioned-DB tables are created by the **build agent itself** — it holds the provisioned DB's owner connection string and runs DDL through its **ungated Bash tool** (a `psql`/node script), so no Rhumb code path observes it. Infra ops have `infra-audit.jsonl` and data writes have `data-audit.jsonl`, but schema evolution has no trail at all.

## Decision: audit, don't gate (B, not C)

DDL stays **autonomous** — same tier as the agent's Bash and file-writes, and any tool-level gate would be theater while the agent retains raw Bash + the DB connection string (it could bypass by running `psql` directly). What's actually missing is **accountability**, so we add a record, not a boundary.

We record at the **database level** (Postgres event triggers), not via an app-level tool. An `apply_schema` tool would only capture DDL the agent chose to route through it, and the migration dogfood showed the agent naturally reaches for Bash — a sparse `ddl-audit.jsonl` would be *worse* than none, inviting the false read "no schema changes happened." A DB-level event trigger is **actor-agnostic**: it fires no matter how the agent connects (tool or Bash), so the record is complete by construction. Chosen over cluster `log_statement=ddl` because a structured, queryable, per-DB table is the accountability artifact the project values elsewhere, and it keeps the change inside Rhumb's provisioning code rather than hand-edited cluster config.

**Net effect: zero agent-facing change.** The agent does DDL however it likes; the database silently records it.

## Design

### Install (at provision time, per database)

In `provisionDatabase`, after `CREATE DATABASE`, open a **superuser connection to the new database** and install, idempotently:

1. **Audit table** (superuser-owned, in `public`):
   ```sql
   CREATE TABLE IF NOT EXISTS public._rhumb_ddl_audit (
     id              bigserial PRIMARY KEY,
     ts              timestamptz NOT NULL DEFAULT now(),
     actor           text NOT NULL DEFAULT current_user,
     command_tag     text,
     object_type     text,
     object_identity text
   );
   ```
2. **Two `SECURITY DEFINER` functions** (superuser-owned, `search_path` pinned to avoid hijacking), schema-qualifying the table:
   - `_rhumb_log_ddl()` — loops `pg_event_trigger_ddl_commands()` (creates/alters), inserts `(command_tag, object_type, object_identity)`.
   - `_rhumb_log_drop()` — loops `pg_event_trigger_dropped_objects()` (drops), inserts using `tg_tag` as `command_tag`.
   Both `CREATE OR REPLACE`.
3. **Event triggers** (idempotent via drop-then-create, since there is no `IF NOT EXISTS` for event triggers):
   ```sql
   DROP EVENT TRIGGER IF EXISTS _rhumb_ddl_audit_end;
   CREATE EVENT TRIGGER _rhumb_ddl_audit_end  ON ddl_command_end EXECUTE FUNCTION _rhumb_log_ddl();
   DROP EVENT TRIGGER IF EXISTS _rhumb_ddl_audit_drop;
   CREATE EVENT TRIGGER _rhumb_ddl_audit_drop ON sql_drop        EXECUTE FUNCTION _rhumb_log_drop();
   ```

Ordering matters: table → functions → triggers, so a trigger never fires before its function/table exist, and the install's own DDL is not self-logged (triggers are created last).

### Why it is tamper-resistant

- `CREATE EVENT TRIGGER` and `DROP EVENT TRIGGER` are **superuser-only** — the agent's owner-role connection cannot remove or replace the triggers.
- The functions and audit table are **superuser-owned**; the owner role lacks `DROP`/ownership on them.
- The functions are **`SECURITY DEFINER`**, so they insert as the superuser even when a DDL statement from the owner role fires them.
- No recursion: `INSERT` into the audit table is DML (no event trigger fires), and the triggers are installed after the table/functions exist.

### The one piece of new plumbing

Event triggers are **per-database**, but today's `AdminExecutor` connects only to the `postgres` maintenance DB. Provisioning needs a superuser executor pointed at the **new** database, derived from `adminConnectionString` by swapping the dbname (path). This is passed into provision as an `adminExecForDb(dbName) => AdminExecutor` factory (keeps `provision.ts` testable with a fake factory).

### Idempotency + backfill

The installer is safe to re-run (`IF NOT EXISTS` / `OR REPLACE` / `DROP ... IF EXISTS`). New DBs get it automatically at provision. The live box's existing `printers` DB (from prior dogfoods) predates this and is backfilled by running the same idempotent installer against it **once during live-verification** — no separate product code path, and it lets us prove the backstop on the box, consistent with how F22/F23 were closed.

## Components & files (agent-host only)

- **New** `agent-host/src/infra/ddlAudit.ts` — the idempotent install SQL statements (pure, testable) + a small `ensureDdlAudit(exec: AdminExecutor)` runner that issues them in order.
- **Modified** `agent-host/src/infra/provision.ts` — after `CREATE DATABASE`, call `ensureDdlAudit(deps.adminExecForDb(name))`.
- **Modified** `agent-host/src/infra/server.ts` — `InfraDeps` gains `adminExecForDb`; threaded into the `provision_database` tool's `provisionDatabase` call.
- **Modified** `agent-host/src/infra/pgAdmin.ts` — a helper to build a connection string for another database on the same server (swap the dbname), used to construct the per-DB superuser executor.
- **Modified** `agent-host/src/index.ts` — construct `adminExecForDb` from `adminConnectionString` and wire it into `createInfraServer`.

No client, dashboard-host, prompt, or gating change. `_rhumb_ddl_audit` is read via a normal `SELECT` (surfacing it in a UI/tool is out of scope — see below).

## Testing

- **`ddlAudit.ts`:** assert the install statement list has the table / both functions / both event triggers, in table→functions→triggers order, and in idempotent forms (`IF NOT EXISTS`, `OR REPLACE`, `DROP EVENT TRIGGER IF EXISTS` before each `CREATE EVENT TRIGGER`); functions are `SECURITY DEFINER` with a pinned `search_path` and schema-qualify `public._rhumb_ddl_audit`.
- **`provision.ts`:** with a fake `adminExecForDb` capturing `exec()` calls, assert that after `CREATE DATABASE` the install statements run against the **new** DB's executor (not the `postgres` admin executor), and that provisioning still returns the registered `DataSourceEntry`. Error path: an install failure surfaces as a provision error.
- Real-Postgres trigger firing is **live-verification** (below), not a unit test — no in-process Postgres.

## Live verification (post-merge, manual)

Redeploy agent-host to the box. Then: (1) provision a throwaway DB → run a `CREATE TABLE`, an `ALTER TABLE`, and a `DROP TABLE` against it via `psql` (simulating the agent's Bash path) → `SELECT * FROM _rhumb_ddl_audit` shows one row per statement with the right `command_tag`/`object_identity`; confirm the owner role **cannot** `DROP EVENT TRIGGER _rhumb_ddl_audit_end` (permission denied). (2) Run the idempotent installer once against `printers` (backfill), then make a schema change and confirm it is recorded. Drop the throwaway DB after.

## Out of scope

- **Gating DDL / credential split (option C):** not doing it — Bash access makes a tool-gate theater; revisit only if the agent's raw DB access is ever removed.
- **App-level `apply_schema` tool + `ddl-audit.jsonl` (B1/B3):** dropped — would under-record vs. the agent's Bash habit and mislead.
- **Surfacing the audit** (a read tool, ontology projection, or dashboard view of `_rhumb_ddl_audit`): the record exists and is queryable; presenting it is a separate follow-up.
- **Cluster `log_statement=ddl`:** rejected in favor of a structured per-DB table.
- Migrating/altering the DML `/data` gate, and F27 (DB reuse-vs-isolation) — separate items.
