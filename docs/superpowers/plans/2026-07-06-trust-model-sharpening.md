# Trust-Model Sharpening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A trusted surface can add and edit rows freely, but every deletion re-gates for human approval, and every executed write records how it was authorized (`approval` vs `trust`).

**Architecture:** Two server-only changes in `dashboard-host/src/data/`. (1) F23: `AuditEntry` gains an optional `auth` field; `executeWrite` takes an `auth` argument threaded into the executed-audit entry; its two call sites pass `"trust"` (router trusted-bypass) and `"approval"` (pending-queue resolve). (2) F22: the router's trusted-bypass branch only auto-executes non-delete ops — a delete from a trusted surface falls through to the pending queue exactly like an untrusted write. No client, sql.ts, trust.ts, or audit.ts change.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Express, Vitest + supertest. Tests live in `dashboard-host/test/`; run with `npm test` from `dashboard-host/`.

## Global Constraints

- Server-only: touch only `dashboard-host/src/data/types.ts`, `writes.ts`, `router.ts` and their tests. No client change.
- `auth` is populated **only** on `decision:"executed"` entries. `denied` and `error` entries carry no `auth`.
- `auth` value is set by call site, never inferred from `op.kind`: router trusted-bypass → `"trust"`; `PendingQueue.resolve("approve")` → `"approval"`.
- Whole-table update/delete already throw in `buildSql` ("requires a where clause") — do NOT add whole-table handling; it is out of scope and already covered.
- ESM import specifiers end in `.js` (e.g. `import ... from "./types.js"`), matching the existing files.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: F23 — record write authorization in the audit

**Files:**
- Modify: `dashboard-host/src/data/types.ts:26-34` (add `auth` to `AuditEntry`)
- Modify: `dashboard-host/src/data/writes.ts:12-31` (`executeWrite` signature + executed entry), `writes.ts:70` (`resolve` call site)
- Modify: `dashboard-host/src/data/router.ts:62-73` (trusted-bypass call site passes `"trust"`)
- Test: `dashboard-host/test/writes.test.ts`, `dashboard-host/test/data-router.test.ts`, `dashboard-host/test/audit-trust.test.ts`

**Interfaces:**
- Consumes: existing `executeWrite(deps, source, op, surfaceId)`, `PendingQueue`, `createDataRouter`.
- Produces: `executeWrite(deps: WriteDeps, source: string, op: DataOp, surfaceId: string | null, auth: "approval" | "trust"): Promise<{ rowCount: number }>` — `auth` is REQUIRED and positional (5th arg). `AuditEntry.auth?: "approval" | "trust"`.

- [ ] **Step 1: Update the existing `executeWrite` tests to the new signature and assert `auth`**

In `dashboard-host/test/writes.test.ts`, replace the two `describe("executeWrite", ...)` tests (lines 22-39) with:

```ts
describe("executeWrite", () => {
  it("runs parameterized SQL and audits an executed write with its auth path", async () => {
    const d = deps();
    const r = await executeWrite(d, "ops", op, "d1", "trust");
    expect(r.rowCount).toBe(3);
    expect(calls[0]).toEqual({ text: 'DELETE FROM "t" WHERE "id" = $1', params: [1] });
    const line = JSON.parse(readFileSync(d.auditPath, "utf8").trim());
    expect(line).toMatchObject({ source: "ops", surfaceId: "d1", decision: "executed", rowCount: 3, auth: "trust" });
  });

  it("audits an error without an auth field and rethrows when the executor fails", async () => {
    const failing: QueryExecutor = { async run() { throw new Error("boom"); } };
    const d = { ...deps(), getExecutor: () => failing };
    await expect(executeWrite(d, "ops", op, "d1", "approval")).rejects.toThrow("boom");
    const line = JSON.parse(readFileSync(d.auditPath, "utf8").trim());
    expect(line).toMatchObject({ decision: "error", error: "boom" });
    expect(line.auth).toBeUndefined();
  });
});
```

Also update the `PendingQueue` "resolve approve" test (lines 50-58) to assert the `approval` auth. Replace it with:

```ts
  it("resolve approve executes, audits with auth:approval, and flips status to executed", async () => {
    const d = deps();
    const q = new PendingQueue(d);
    q.enqueue("ops", op, "d1");
    await q.resolve("p1", "approve");
    expect(calls).toHaveLength(1);
    expect(q.get("p1")).toEqual({ status: "executed", result: { rowCount: 3 } });
    const line = JSON.parse(readFileSync(d.auditPath, "utf8").trim());
    expect(line).toMatchObject({ decision: "executed", auth: "approval" });
  });
```

- [ ] **Step 2: Run the writes tests to verify they fail**

Run: `cd dashboard-host && npx vitest run test/writes.test.ts`
Expected: FAIL — `executeWrite` expects 4 args but got 5 (TS/type error) or the `auth` assertions fail because the field is not written yet.

- [ ] **Step 3: Add `auth` to `AuditEntry`**

In `dashboard-host/src/data/types.ts`, change the `AuditEntry` interface to:

```ts
export interface AuditEntry {
  ts: string;
  source: string;
  surfaceId: string | null;
  op: DataOp;
  decision: "executed" | "denied" | "error";
  rowCount?: number;
  error?: string;
  auth?: "approval" | "trust";
}
```

- [ ] **Step 4: Thread `auth` through `executeWrite` and its call sites**

In `dashboard-host/src/data/writes.ts`, change `executeWrite` (lines 12-31) to:

```ts
export async function executeWrite(
  deps: WriteDeps,
  source: string,
  op: DataOp,
  surfaceId: string | null,
  auth: "approval" | "trust",
): Promise<{ rowCount: number }> {
  try {
    const result = await deps.getExecutor(source).run(buildSql(op));
    appendAudit(deps.auditPath, {
      ts: deps.now(), source, surfaceId, op, decision: "executed", rowCount: result.rowCount, auth,
    });
    return { rowCount: result.rowCount };
  } catch (err) {
    appendAudit(deps.auditPath, {
      ts: deps.now(), source, surfaceId, op, decision: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
```

In the same file, `PendingQueue.resolve` (line 70), pass `"approval"`:

```ts
      const result = await executeWrite(this.deps, w.source, w.op, w.surfaceId, "approval");
```

In `dashboard-host/src/data/router.ts`, the trusted-bypass `executeWrite` call (lines 64-67), pass `"trust"`:

```ts
        const result = await executeWrite(
          { getExecutor: deps.getExecutor, auditPath: deps.auditPath, now: deps.now, id: () => "" },
          source.id, op, surfaceId, "trust",
        );
```

- [ ] **Step 5: Run the writes tests to verify they pass**

Run: `cd dashboard-host && npx vitest run test/writes.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Add a router-level assertion that executed writes carry the right auth**

In `dashboard-host/test/data-router.test.ts`, the `app()` helper writes its audit to `join(dir, "audit.jsonl")`. Add these two tests at the end of the top-level `describe("data router", ...)` block (after the `GET /pending lists pending writes` test, before the nested `describe`s):

```ts
  it("a trusted surface's executed write is audited with auth:trust", async () => {
    const { addTrust } = await import("../src/data/trust.js");
    addTrust(join(dir, "trust.json"), { source: "ops", surfaceId: "d1" });
    const a = app();
    const w = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    expect(w.body.status).toBe("executed");
    const line = JSON.parse(readFileSync(join(dir, "audit.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ decision: "executed", auth: "trust" });
  });

  it("an operator-approved write is audited with auth:approval", async () => {
    const a = app();
    const w = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    await request(a).post(`/data/pending/${w.body.pendingId}/resolve`).send({ decision: "approve" });
    const line = JSON.parse(readFileSync(join(dir, "audit.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ decision: "executed", auth: "approval" });
  });
```

Add `readFileSync` to the `node:fs` import at the top of the file (line 3 currently imports `mkdtempSync, rmSync`):

```ts
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
```

- [ ] **Step 7: Extend the audit-trust type test to cover the `auth` field**

In `dashboard-host/test/audit-trust.test.ts`, replace the `appendAudit` test body (lines 14-23) so it round-trips an `auth` field:

```ts
  it("appends JSONL lines and preserves the auth field", () => {
    const p = join(dir, "a.jsonl");
    const e: AuditEntry = { ts: "t1", source: "ops", surfaceId: "d1", op: { kind: "delete", table: "t", where: { id: 1 } }, decision: "executed", rowCount: 1, auth: "approval" };
    appendAudit(p, e);
    appendAudit(p, { ...e, ts: "t2", decision: "denied", auth: undefined });
    const lines = readFileSync(p, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ ts: "t1", auth: "approval" });
    expect(JSON.parse(lines[1]).decision).toBe("denied");
    expect(JSON.parse(lines[1]).auth).toBeUndefined();
  });
```

- [ ] **Step 8: Run the full dashboard-host suite to verify green**

Run: `cd dashboard-host && npm test`
Expected: PASS — all suites green (no other call site of `executeWrite` remains on the old 4-arg signature).

- [ ] **Step 9: Commit**

```bash
git add dashboard-host/src/data/types.ts dashboard-host/src/data/writes.ts dashboard-host/src/data/router.ts dashboard-host/test/writes.test.ts dashboard-host/test/data-router.test.ts dashboard-host/test/audit-trust.test.ts
git commit -m "feat(dashboard): audit records write authorization path (approval vs trust) — F23

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: F22 — deletions from a trusted surface re-gate for approval

**Files:**
- Modify: `dashboard-host/src/data/router.ts:62` (the trusted-bypass condition)
- Test: `dashboard-host/test/data-router.test.ts`

**Interfaces:**
- Consumes: `executeWrite(..., auth)` from Task 1; the existing `isTrusted`, `deps.queue.enqueue`.
- Produces: no signature change. Behavior change: `POST /:source/write` auto-executes under trust only when `op.kind !== "delete"`; a trusted delete returns `202 {status:"pending"}`.

- [ ] **Step 1: Write the failing tests for the delete re-gate**

In `dashboard-host/test/data-router.test.ts`, add these tests at the end of the top-level `describe("data router", ...)` block (alongside the Task 1 audit tests):

```ts
  it("a trusted surface's DELETE re-gates (enqueues) instead of auto-executing", async () => {
    const { addTrust } = await import("../src/data/trust.js");
    addTrust(join(dir, "trust.json"), { source: "ops", surfaceId: "d1" });
    const a = app();
    const res = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "delete", table: "t", where: { id: 1 } } });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(calls).toHaveLength(0); // not executed under trust
  });

  it("a trusted surface's INSERT and UPDATE still auto-execute", async () => {
    const { addTrust } = await import("../src/data/trust.js");
    addTrust(join(dir, "trust.json"), { source: "ops", surfaceId: "d1" });
    const a = app();
    const ins = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    expect(ins.body.status).toBe("executed");
    const upd = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "update", table: "t", where: { id: 1 }, values: { a: 2 } } });
    expect(upd.body.status).toBe("executed");
  });

  it("a re-gated trusted DELETE audits as auth:approval once approved", async () => {
    const { addTrust } = await import("../src/data/trust.js");
    addTrust(join(dir, "trust.json"), { source: "ops", surfaceId: "d1" });
    const a = app();
    const w = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "delete", table: "t", where: { id: 1 } } });
    await request(a).post(`/data/pending/${w.body.pendingId}/resolve`).send({ decision: "approve" });
    const line = JSON.parse(readFileSync(join(dir, "audit.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ decision: "executed", op: { kind: "delete" }, auth: "approval" });
  });
```

- [ ] **Step 2: Run the router tests to verify they fail**

Run: `cd dashboard-host && npx vitest run test/data-router.test.ts`
Expected: FAIL — the trusted DELETE currently auto-executes, so the first new test sees `status:"executed"` / `calls.length === 1`, and the third sees `auth:"trust"`.

- [ ] **Step 3: Make the trusted-bypass branch delete-aware**

In `dashboard-host/src/data/router.ts`, change the trusted-bypass condition (line 62) from:

```ts
    if (isTrusted(loadTrust(deps.trustPath), source.id, surfaceId)) {
```

to:

```ts
    // Trust lets a surface add and edit rows freely; a deletion always re-gates
    // for a human, so a trusted DELETE falls through to the pending queue.
    if (op.kind !== "delete" && isTrusted(loadTrust(deps.trustPath), source.id, surfaceId)) {
```

- [ ] **Step 4: Run the router tests to verify they pass**

Run: `cd dashboard-host && npx vitest run test/data-router.test.ts`
Expected: PASS (all tests in the file, including the pre-existing trusted-insert-executes tests).

- [ ] **Step 5: Run the full dashboard-host suite**

Run: `cd dashboard-host && npm test`
Expected: PASS — all suites green.

- [ ] **Step 6: Commit**

```bash
git add dashboard-host/src/data/router.ts dashboard-host/test/data-router.test.ts
git commit -m "feat(dashboard): trusted surface deletes re-gate for approval — F22

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Live Verification (post-merge, manual — not a plan task)

After the branch merges and dashboard-host is redeployed to the box: re-run the CRUD dogfood's coarseness probe. A DELETE from the still-trusted `filament-spools` surface must now return `{status:"pending"}` (not `{status:"executed"}`); approving it in the client dialog then lands an audit line with `auth:"approval"`. A trusted INSERT/UPDATE still returns `{status:"executed"}` with `auth:"trust"`. This closes the loop the dogfood opened.

## Self-Review

**Spec coverage:**
- F22 (delete re-gates, insert/update still auto-execute, whole-table already blocked) → Task 2. ✓
- F23 (`auth` on executed entries only, threaded via `executeWrite`, `"trust"`/`"approval"` by call site, error carries no auth) → Task 1. ✓
- Server-only scope, three files → both tasks stay within `types.ts`/`writes.ts`/`router.ts` + tests. ✓
- Test extensions named in the spec (data-router, writes, audit-trust) → all three modified. ✓
- Live verification → captured as a post-merge manual step. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/vague steps; every code step shows complete code. ✓

**Type consistency:** `executeWrite`'s 5th param is `auth: "approval" | "trust"` everywhere (writes.ts signature, resolve call, router call, both test files). `AuditEntry.auth?: "approval" | "trust"` matches. Task 2 references `executeWrite(..., auth)` produced by Task 1 without changing its signature. ✓
