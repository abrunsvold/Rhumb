# Trust-model sharpening: gate deletes + record write authorization (F22 / F23)

**Date:** 2026-07-06 · **Status:** approved design
**Fixes:** F22 (Important) and F23 (Important) from [docs/dogfood/2026-07-06-crud-trust.md](../../dogfood/2026-07-06-crud-trust.md)

## Problem

The CRUD dogfood exercised the write-back/trust stack live and surfaced two Important gaps in `dashboard-host/src/data/`:

- **F22 — trust is coarse.** `isTrusted(source, surfaceId)` is the only gate on the trusted-write path (`router.ts`), so one "trust this surface" approval auto-executes *every* future write from that surface — any table, any op-kind. Proven live: a post-trust DELETE executed ungated (`rowCount:1`, no dialog).
- **F23 — the audit can't say how a write was authorized.** `executeWrite` always logs `decision:"executed"` whether it was reached via an operator approval (`PendingQueue.resolve(approve)`) or via the trusted-bypass branch. `data-audit.jsonl` cannot answer "did a human gate this write, or did prior trust auto-execute it?" — the exact accountability question, and audit trustworthiness was day-2's smoking gun.

## Grounding facts (verified in current code)

- `DataOp` requires `where` on update and delete; `buildSql` **already throws** "requires a where clause" on an empty `where: {}` for both — so a whole-table update/delete can never execute. No extra whole-table handling is needed; the only destructive op that reaches execution with trust today is a scoped DELETE (and scoped UPDATE, which we keep auto-executing).
- The trusted-bypass path is `router.ts` `POST /:source/write` → `if (isTrusted(...)) executeWrite(...)`; the approval path is `PendingQueue.resolve("approve")` → `executeWrite(...)`. Both call the same `executeWrite`, which is where the flat audit entry is written.

## Design

Server-only (dashboard-host); no client change required — a re-gated delete already flows through the existing ConfirmationDialog, which renders the `kind:"delete"` op.

### F22 — deletions always require a human

In `router.ts` `POST /:source/write`, the trust branch becomes delete-aware:

- **Auto-execute under trust only when `op.kind !== "delete"`.** Insert and scoped update from a trusted surface still auto-execute (the useful, low-risk common case).
- **A DELETE from a trusted surface re-enqueues** (`deps.queue.enqueue(...)` → 202 `{pendingId, status:"pending"}`), exactly like an untrusted write — a human must approve it in the dialog.

Rule, stated plainly: *trust lets a surface add and edit rows freely; removing rows always needs a human.* Whole-table ops are already impossible (empty `where` throws in `buildSql`), so this one condition fully closes the F22 sharp edge.

### F23 — record the authorization path in the audit

- `AuditEntry` gains `auth?: "approval" | "trust"`, populated **only** on `decision:"executed"` entries. `denied` and `error` entries carry no `auth`.
- `executeWrite(deps, source, op, surfaceId, auth)` takes the authorization as a parameter and passes it into the `decision:"executed"` audit entry. The `error` catch entry is unchanged (no `auth`).
- Call sites: the trusted-bypass call in `router.ts` passes `"trust"`; `PendingQueue.resolve("approve")` passes `"approval"`. (After F22, the only trusted-bypass executes are non-delete ops, so `auth:"trust"` never accompanies a delete — a nice invariant, but the field is set by call site, not inferred from op-kind.)

Now every executed write line answers "how was this authorized," and — combined with F22 — a delete can only ever appear with `auth:"approval"`.

## Components & files

- `dashboard-host/src/data/types.ts` — add `auth?: "approval" | "trust"` to `AuditEntry`.
- `dashboard-host/src/data/writes.ts` — `executeWrite` gains an `auth` param threaded into the executed-audit entry; `PendingQueue.resolve("approve")` passes `"approval"`.
- `dashboard-host/src/data/router.ts` — the `POST /:source/write` trust branch: auto-execute (passing `"trust"`) only for non-delete ops; deletes fall through to `enqueue`.
- No change to `sql.ts`, `trust.ts`, `audit.ts`, or the client.

## Testing

Extend existing suites (`dashboard-host/test/data-router.test.ts`, `writes.test.ts`, `audit-trust.test.ts`):

- Trusted surface + insert/scoped-update → auto-executes, audit `decision:"executed", auth:"trust"`.
- Trusted surface + **delete** → **enqueues** (202 pending, NOT executed); after approval, audit `decision:"executed", auth:"approval"`.
- Untrusted write approved → `auth:"approval"`; denied → `decision:"denied"` no `auth`; error → `decision:"error"` no `auth`.
- `executeWrite` unit: the `auth` argument lands in the executed entry and is absent from the error entry.

## Live verification

After merge-ready: redeploy dashboard-host to the box (tarball convention) and re-run the CRUD dogfood's coarseness probe — a DELETE from the (still-trusted) `filament-spools` surface must now return `{status:"pending"}`, not `{status:"executed"}`; approving it then lands an audit line with `auth:"approval"`. This closes the loop the dogfood opened.

## Out of scope

- Per-op-kind or per-table trust scoping (the richer F22 alternative) — the delete-boundary rule is the minimal, defensible fix; finer scoping can follow if a real need appears.
- Row-count caps / dry-run counting.
- The client dialog hint ("deletions always require approval") — a small follow-up; the delete re-gates correctly without it, just without an explanatory line.
- F17 (DDL gating) and F27 (per-tool DB isolation) — separate roadmap items.
