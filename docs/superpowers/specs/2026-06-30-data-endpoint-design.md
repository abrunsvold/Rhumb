# RHUMBR Data Endpoint Design Spec (Plan 4 of 7)

**Date:** 2026-06-30
**Status:** Approved design (sub-spec of the RHUMBR master spec §3.3).
**Depends on:** the dashboard host (Plan 2) and the client shell (Plan 3b).

---

## 1. Role

The data endpoint turns Claude-built surfaces from static pages into **live-data dashboards that can read and write the operator's data**, through a sanctioned, audited API. It lives **inside the dashboard host** as `/data/*` routes, so surfaces (sandboxed iframes served by that host) call it **same-origin** — no CORS. Writes are mediated through a **pending-write queue** that the desktop client confirms, since surfaces have no IPC.

This plan implements the full read + write + confirmation spine against **PostgreSQL** as the v1 source type, plus two carry-in cleanups from the Plan 3b review.

## 2. Declared sources

A config file lists the data sources the operator sanctions: path from `RHUMBR_DATA_SOURCES` (default `<workspace>/data-sources.json`).

```json
[
  { "id": "ops", "type": "postgres", "mode": "read-write", "connectionString": "postgres://user:pass@host:5432/db" },
  { "id": "reporting", "type": "postgres", "mode": "read", "connectionString": "postgres://..." }
]
```

- `id` URL-safe (`^[A-Za-z0-9._-]+$`); `mode` is `read` or `read-write`; `type` is `postgres` in v1 (the field keeps the contract pluggable — MySQL/REST/files slot in later).
- A malformed entry is skipped (logged), never fatal. The secret connection string lives in the operator's own config file on the box (same trust posture as the Claude token).

## 3. Structured operations → parameterized SQL (the safety core)

Surfaces never send raw SQL. An operation is one of:

```ts
type DataOp =
  | { kind: "select"; table: string; where?: Record<string, unknown>; limit?: number }
  | { kind: "insert"; table: string; values: Record<string, unknown> }
  | { kind: "update"; table: string; where: Record<string, unknown>; values: Record<string, unknown> }
  | { kind: "delete"; table: string; where: Record<string, unknown> };
```

- `table` and column names are validated against `^[A-Za-z_][A-Za-z0-9_]*$` (identifier allowlist) and quoted; `where`/`values` become **parameterized placeholders** (`$1, $2, …`) — values never interpolated.
- `where` is equality-only in v1 (`col = $n` joined by `AND`). `update`/`delete` **require** a non-empty `where` (no unbounded mutation).
- This translator (`buildSql(op) -> { text, params }`) is **pure and unit-tested** — the heart of the "no raw DB access" guarantee.

## 4. Executor abstraction (real DB behind a seam)

```ts
interface QueryExecutor {
  run(sql: { text: string; params: unknown[] }): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}
```

- A **Postgres executor** wraps a `pg` `Pool` per source. The route layer, queue, trust, and audit logic depend only on `QueryExecutor`, so they are unit-tested with a **fake executor**; the real `pg` path is verified in the live run against a Postgres instance.

## 5. HTTP surface (`/data/*`, on the dashboard host)

- `POST /data/:source/query` — body `{ op }` where `op.kind === "select"`. Executes directly (reads need no confirmation). Returns `{ rows }`. 400 if the source is unknown or the op isn't a select.
- `POST /data/:source/write` — body `{ op }` where `op.kind` ∈ insert/update/delete. The source must be `read-write` (else 403). The **calling surface id** is derived from the request `Referer` (`…/surfaces/<id>/…`); unknown referer → `surfaceId = null` (always untrusted).
  - If the surface is **trusted** for this source → execute, append to the audit log, return `{ status: "executed", result }`.
  - Otherwise → enqueue a pending write, return `{ pendingId, status: "pending" }`.
- `GET /data/pending/:pendingId` — the surface polls; returns `{ status: "pending" | "executed" | "denied", result? }`.
- `GET /data/pending/stream` — SSE; emits each pending write `{ pendingId, source, op, surfaceId, createdAt }` on creation (and a `resolved` event when one is decided), for the client to react to. Reuses the dashboard host's SSE writer.
- `GET /data/pending` — list current pending writes (for client reconnect/dedup).
- `POST /data/pending/:pendingId/resolve` — body `{ decision: "approve" | "deny", trustSurface?: boolean }`. Approve → execute + audit + mark `executed` (store the result for the surface's poll). Deny → audit + mark `denied`. `trustSurface: true` (only meaningful with a known `surfaceId`) → add `{ source, surfaceId }` to the persisted trust store.

The pending queue is an in-memory `Map<pendingId, PendingWrite>`; resolved entries keep their result briefly so the surface's next poll sees it, then are reaped.

## 6. Trust store (persisted)

- File at `RHUMBR_DATA_TRUST` (default `<workspace>/data-trust.json`): a list of `{ source, surfaceId }` pairs the operator has trusted.
- Loaded on startup; appended (and rewritten) when a resolve carries `trustSurface: true`. `isTrusted(source, surfaceId)` is a pure check, unit-tested; the file read/write is a thin helper.

## 7. Audit log

- Append-only JSONL at `RHUMBR_DATA_AUDIT` (default `<workspace>/data-audit.jsonl`). One line per write decision:
  `{ ts, source, surfaceId, op, decision: "executed" | "denied" | "error", rowCount?, error? }`
  (`executed` on a successful write, `denied` when the operator declines, `error` when an approved write fails in the executor).
- The append helper is a thin, testable wrapper (write to a temp path in tests). Reads/queries are **not** audited in v1 (writes and decisions are).

## 8. Client additions

- **Rust proxy (`proxy.rs`)**: `start_pending_stream(dashboard_base, on_pending: Channel<Value>)` + `stop_pending_stream()` (subscribe to `/data/pending/stream`, same shape as the registry stream); `resolve_pending(dashboard_base, pending_id, decision, trust_surface)` (POST resolve). Cancellation via the existing `StreamState` pattern.
- **React**: a `ConfirmationDialog` driven by a pending-writes store fed by the pending Channel. It shows the source, the structured op (human-readable), the surface id, and a **"trust this surface"** checkbox; Approve/Deny call `resolve_pending`. A small pure reducer (`pendingStore`) maps the pending stream to the dialog queue and is unit-tested. The dialog is wired into `App`/`Workspace` so it overlays regardless of the active tab.

## 9. Carry-in cleanups (from the Plan 3b review)

- **`proxy.rs` SSE pump:** buffer bytes and decode incrementally (or `from_utf8_lossy` with a carry buffer) so a multibyte UTF-8 sequence split across `bytes_stream()` chunks doesn't drop a frame.
- **`tauri.conf.json`:** rename the bundle `identifier` off the scaffold default `com.tauri.dev` (e.g. `com.rhumbr.client`).

## 10. Error handling

- Unknown/misconfigured source → 400/404 with a clear message; other sources keep working.
- A read-only source receiving a write → 403.
- An `update`/`delete` without `where` → 400 (guarded in `buildSql`).
- A DB/executor error → the route returns 500 with a sanitized message. For a write: a `decision:"executed"` audit line is appended only on success; a failed (approved) write appends `decision:"error"` with the error instead.
- A surface polling a `pendingId` that doesn't exist (reaped/never created) → 404.
- A dropped pending stream is retried by the Rust side (backoff); the client re-lists `/data/pending` on reconnect to avoid missing a confirmation.

## 11. Testing & verification

- **Unit (dashboard-host, Vitest):** `buildSql` (each kind; identifier rejection; parameterization; required-`where` guard); the pending-queue + trust + audit logic with a **fake `QueryExecutor`** (write→pending; trusted write→executed; resolve approve/deny; trust persistence). The data routes via Supertest with a fake executor.
- **Unit (client):** the `pendingStore` reducer; the Rust additions are build-verified (`cargo build`); the SSE-pump UTF-8 fix gets a Rust unit test (a frame whose multibyte char is split across two `push` calls is still parsed).
- **Live run (driver):** point a source at a real Postgres (local or Proxmox); a surface that selects rows renders live data; a surface write pops the confirmation dialog in the client → approve → row changes + audit line appears; "trust this surface" makes the next write skip the dialog.

## 12. Scope / out of scope

- **In:** Postgres source type; structured read/write ops + parameterized SQL; declared-sources config; the pending-write queue + client-confirmed writes; persisted trust; audit log; the client Rust + React confirmation pieces; the two carry-in cleanups.
- **Out (later plans):** other source types (MySQL/REST/files); non-equality `where` (ranges, joins); auto-provisioned databases (Plan 5 infra capability creates DBs that auto-register here); spawned `service` surfaces (Plan 6); ontology (Plan 7); read auditing; row-level auth.

## 13. Implementation phases (one plan, two phases)

1. **Data endpoint** (dashboard-host): config, `buildSql`, executor seam + Postgres impl, the `/data/*` routes, pending queue, trust, audit — fully unit-tested behind the fake executor.
2. **Client confirmation** (client Rust + React): the pending-stream + resolve commands, the `pendingStore`, the `ConfirmationDialog`, wiring; plus the two carry-in cleanups.

The live run (real Postgres) verifies phase 1 + 2 end-to-end.
