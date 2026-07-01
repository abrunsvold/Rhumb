# RHUMBR Data Endpoint Implementation Plan (Plan 4 of 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Claude-built surfaces a sanctioned live-data spine — read + client-confirmed write against declared PostgreSQL sources, with structured (never raw) SQL, an audit log, and persisted per-surface trust — plus two carry-in cleanups from the Plan 3b review.

**Architecture:** Phase 1 adds `/data/*` routes to the existing `dashboard-host` (same-origin to surfaces). A pure `buildSql` translates structured ops to parameterized SQL; a `QueryExecutor` seam keeps the route/queue/trust/audit logic unit-testable behind a fake, with a real `pg` executor verified live. Writes go through a pending-write queue the desktop client confirms. Phase 2 adds the Rust pending-stream/resolve commands and a React confirmation dialog.

**Tech Stack:** TypeScript (strict), Node ≥ 20, Express 4, `pg` (node-postgres), Vitest + Supertest (dashboard-host); Tauri v2 Rust + React (client).

## Global Constraints

- **Placement:** the data endpoint is `/data/*` routes inside `dashboard-host` — same origin as the surfaces it serves. No CORS.
- **No raw SQL:** surfaces send structured ops `{kind, table, where?, values?, limit?}`; identifiers are validated against `^[A-Za-z_][A-Za-z0-9_]*$` and quoted, values are parameterized (`$1, $2, …`). `update`/`delete` require a non-empty `where`.
- **Write mediation:** a `read-write` source's write executes directly only if the calling surface (identified from the `Referer` path `…/surfaces/<id>/…`) is **trusted**; otherwise it is enqueued as a pending write for the client to confirm. A `read`-mode source rejects writes (403).
- **Persistence paths (env-overridable):** sources `RHUMBR_DATA_SOURCES` (default `<workspace>/data-sources.json`), trust `RHUMBR_DATA_TRUST` (default `<workspace>/data-trust.json`), audit `RHUMBR_DATA_AUDIT` (default `<workspace>/data-audit.jsonl`).
- **Executor seam:** all logic depends on `interface QueryExecutor { run(sql): Promise<{rows; rowCount}> }`; the `pg` implementation is the only DB-touching code and is live-verified, not unit-tested.
- **Node ≥ 20, TS strict, ES modules; dashboard-host local imports use the `.js` suffix; client (Vite) imports use no suffix.**
- **Reuse:** the dashboard host's existing `writeSseEvent`/SSE pattern and the client's existing `StreamState`/Channel proxy pattern — extend, don't duplicate.

---

### Task 1: Data types + declared-sources config

**Files:**
- Create: `dashboard-host/src/data/types.ts`, `dashboard-host/src/data/sources.ts`
- Test: `dashboard-host/test/data-sources.test.ts`

**Interfaces:**
- Produces (`types.ts`): `DataSource`, `DataOp`, `AuditEntry`, `PendingWrite`, `QueryExecutor`.
- Produces (`sources.ts`): `loadDataSources(path: string): DataSource[]` (missing file → `[]`; invalid entries skipped), `findSource(sources: DataSource[], id: string): DataSource | undefined`.

- [ ] **Step 1: Create `dashboard-host/src/data/types.ts`**

```typescript
export interface DataSource {
  id: string;
  type: "postgres";
  mode: "read" | "read-write";
  connectionString: string;
}

export type DataOp =
  | { kind: "select"; table: string; where?: Record<string, unknown>; limit?: number }
  | { kind: "insert"; table: string; values: Record<string, unknown> }
  | { kind: "update"; table: string; where: Record<string, unknown>; values: Record<string, unknown> }
  | { kind: "delete"; table: string; where: Record<string, unknown> };

export interface QueryExecutor {
  run(sql: { text: string; params: unknown[] }): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

export interface PendingWrite {
  pendingId: string;
  source: string;
  op: DataOp;
  surfaceId: string | null;
  createdAt: string;
}

export interface AuditEntry {
  ts: string;
  source: string;
  surfaceId: string | null;
  op: DataOp;
  decision: "executed" | "denied" | "error";
  rowCount?: number;
  error?: string;
}
```

- [ ] **Step 2: Write the failing test** — `dashboard-host/test/data-sources.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDataSources, findSource } from "../src/data/sources.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-ds-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const valid = [
  { id: "ops", type: "postgres", mode: "read-write", connectionString: "postgres://x/db1" },
  { id: "rep", type: "postgres", mode: "read", connectionString: "postgres://x/db2" },
];

describe("loadDataSources", () => {
  it("loads valid sources", () => {
    const p = join(dir, "ds.json");
    writeFileSync(p, JSON.stringify(valid));
    expect(loadDataSources(p)).toEqual(valid);
  });

  it("returns [] when the file is missing", () => {
    expect(loadDataSources(join(dir, "nope.json"))).toEqual([]);
  });

  it("skips invalid entries (bad id, missing fields, wrong mode)", () => {
    const p = join(dir, "mixed.json");
    writeFileSync(p, JSON.stringify([
      valid[0],
      { id: "../bad", type: "postgres", mode: "read", connectionString: "x" },
      { id: "nomode", type: "postgres", connectionString: "x" },
      { id: "badmode", type: "postgres", mode: "write", connectionString: "x" },
    ]));
    expect(loadDataSources(p).map((s) => s.id)).toEqual(["ops"]);
  });

  it("returns [] on malformed JSON", () => {
    const p = join(dir, "broken.json");
    writeFileSync(p, "{ not json");
    expect(loadDataSources(p)).toEqual([]);
  });
});

describe("findSource", () => {
  it("finds by id", () => {
    expect(findSource(valid as never, "rep")?.mode).toBe("read");
    expect(findSource(valid as never, "missing")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/data-sources.test.ts`
Expected: FAIL — cannot resolve `../src/data/sources.js`.

- [ ] **Step 4: Create `dashboard-host/src/data/sources.ts`**

```typescript
import { readFileSync, existsSync } from "node:fs";
import type { DataSource } from "./types.js";

const ID_RE = /^[A-Za-z0-9._-]+$/;

function isValid(raw: unknown): raw is DataSource {
  if (typeof raw !== "object" || raw === null) return false;
  const s = raw as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    ID_RE.test(s.id) &&
    s.type === "postgres" &&
    (s.mode === "read" || s.mode === "read-write") &&
    typeof s.connectionString === "string" &&
    s.connectionString.length > 0
  );
}

export function loadDataSources(path: string): DataSource[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValid);
}

export function findSource(sources: DataSource[], id: string): DataSource | undefined {
  return sources.find((s) => s.id === id);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/data-sources.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add dashboard-host/src/data/types.ts dashboard-host/src/data/sources.ts dashboard-host/test/data-sources.test.ts
git commit -m "feat(dashboard-host): data types and declared-source config loader"
```

---

### Task 2: `buildSql` — structured op → parameterized SQL (safety core)

**Files:**
- Create: `dashboard-host/src/data/sql.ts`
- Test: `dashboard-host/test/sql.test.ts`

**Interfaces:**
- Consumes: `DataOp` (Task 1).
- Produces: `buildSql(op: DataOp): { text: string; params: unknown[] }` — pure; throws `Error` on an invalid identifier or a missing required `where`/`values`.

- [ ] **Step 1: Write the failing test** — `dashboard-host/test/sql.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { buildSql } from "../src/data/sql.js";

describe("buildSql", () => {
  it("select with where + limit parameterizes values", () => {
    expect(buildSql({ kind: "select", table: "users", where: { id: 5, name: "a" }, limit: 10 })).toEqual({
      text: 'SELECT * FROM "users" WHERE "id" = $1 AND "name" = $2 LIMIT $3',
      params: [5, "a", 10],
    });
  });

  it("select without where", () => {
    expect(buildSql({ kind: "select", table: "users" })).toEqual({ text: 'SELECT * FROM "users"', params: [] });
  });

  it("insert", () => {
    expect(buildSql({ kind: "insert", table: "t", values: { a: 1, b: "x" } })).toEqual({
      text: 'INSERT INTO "t" ("a", "b") VALUES ($1, $2)',
      params: [1, "x"],
    });
  });

  it("update sets then where, in param order", () => {
    expect(buildSql({ kind: "update", table: "t", values: { a: 1 }, where: { id: 7 } })).toEqual({
      text: 'UPDATE "t" SET "a" = $1 WHERE "id" = $2',
      params: [1, 7],
    });
  });

  it("delete", () => {
    expect(buildSql({ kind: "delete", table: "t", where: { id: 7 } })).toEqual({
      text: 'DELETE FROM "t" WHERE "id" = $1',
      params: [7],
    });
  });

  it("rejects an invalid table identifier", () => {
    expect(() => buildSql({ kind: "select", table: "users; drop" })).toThrow(/identifier/);
  });

  it("rejects an invalid column identifier", () => {
    expect(() => buildSql({ kind: "select", table: "t", where: { "a b": 1 } })).toThrow(/identifier/);
  });

  it("requires a where on update and delete", () => {
    expect(() => buildSql({ kind: "update", table: "t", values: { a: 1 }, where: {} })).toThrow(/where/);
    expect(() => buildSql({ kind: "delete", table: "t", where: {} })).toThrow(/where/);
  });

  it("requires values on insert and update", () => {
    expect(() => buildSql({ kind: "insert", table: "t", values: {} })).toThrow(/values/);
    expect(() => buildSql({ kind: "update", table: "t", values: {}, where: { id: 1 } })).toThrow(/values/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/sql.test.ts`
Expected: FAIL — cannot resolve `../src/data/sql.js`.

- [ ] **Step 3: Create `dashboard-host/src/data/sql.ts`**

```typescript
import type { DataOp } from "./types.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid identifier: ${name}`);
  return `"${name}"`;
}

export function buildSql(op: DataOp): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  switch (op.kind) {
    case "select": {
      let text = `SELECT * FROM ${ident(op.table)}`;
      const whereKeys = op.where ? Object.keys(op.where) : [];
      if (whereKeys.length > 0) {
        const conds = whereKeys.map((k) => `${ident(k)} = ${push(op.where![k])}`);
        text += ` WHERE ${conds.join(" AND ")}`;
      }
      if (op.limit !== undefined) text += ` LIMIT ${push(op.limit)}`;
      return { text, params };
    }
    case "insert": {
      const keys = Object.keys(op.values);
      if (keys.length === 0) throw new Error("insert requires values");
      const cols = keys.map(ident).join(", ");
      const vals = keys.map((k) => push(op.values[k])).join(", ");
      return { text: `INSERT INTO ${ident(op.table)} (${cols}) VALUES (${vals})`, params };
    }
    case "update": {
      const setKeys = Object.keys(op.values);
      const whereKeys = Object.keys(op.where);
      if (setKeys.length === 0) throw new Error("update requires values");
      if (whereKeys.length === 0) throw new Error("update requires a where clause");
      const sets = setKeys.map((k) => `${ident(k)} = ${push(op.values[k])}`).join(", ");
      const conds = whereKeys.map((k) => `${ident(k)} = ${push(op.where[k])}`).join(" AND ");
      return { text: `UPDATE ${ident(op.table)} SET ${sets} WHERE ${conds}`, params };
    }
    case "delete": {
      const whereKeys = Object.keys(op.where);
      if (whereKeys.length === 0) throw new Error("delete requires a where clause");
      const conds = whereKeys.map((k) => `${ident(k)} = ${push(op.where[k])}`).join(" AND ");
      return { text: `DELETE FROM ${ident(op.table)} WHERE ${conds}`, params };
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/sql.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src/data/sql.ts dashboard-host/test/sql.test.ts
git commit -m "feat(dashboard-host): structured-op to parameterized SQL translator"
```

---

### Task 3: Audit log + trust store

**Files:**
- Create: `dashboard-host/src/data/audit.ts`, `dashboard-host/src/data/trust.ts`
- Test: `dashboard-host/test/audit-trust.test.ts`

**Interfaces:**
- Consumes: `AuditEntry` (Task 1).
- Produces (`audit.ts`): `appendAudit(path: string, entry: AuditEntry): void` (appends one JSONL line).
- Produces (`trust.ts`): `interface TrustPair { source: string; surfaceId: string }`; `loadTrust(path: string): TrustPair[]`; `isTrusted(trust: TrustPair[], source: string, surfaceId: string | null): boolean` (always false if `surfaceId` is null); `addTrust(path: string, pair: TrustPair): TrustPair[]` (dedupes, rewrites the file, returns the new list).

- [ ] **Step 1: Write the failing test** — `dashboard-host/test/audit-trust.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit } from "../src/data/audit.js";
import { loadTrust, isTrusted, addTrust } from "../src/data/trust.js";
import type { AuditEntry } from "../src/data/types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-at-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("appendAudit", () => {
  it("appends JSONL lines", () => {
    const p = join(dir, "a.jsonl");
    const e: AuditEntry = { ts: "t1", source: "ops", surfaceId: "d1", op: { kind: "delete", table: "t", where: { id: 1 } }, decision: "executed", rowCount: 1 };
    appendAudit(p, e);
    appendAudit(p, { ...e, ts: "t2", decision: "denied" });
    const lines = readFileSync(p, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).ts).toBe("t1");
    expect(JSON.parse(lines[1]).decision).toBe("denied");
  });
});

describe("trust", () => {
  it("loadTrust returns [] for a missing file", () => {
    expect(loadTrust(join(dir, "nope.json"))).toEqual([]);
  });

  it("isTrusted matches a pair and is false for null surfaceId", () => {
    const trust = [{ source: "ops", surfaceId: "d1" }];
    expect(isTrusted(trust, "ops", "d1")).toBe(true);
    expect(isTrusted(trust, "ops", "d2")).toBe(false);
    expect(isTrusted(trust, "rep", "d1")).toBe(false);
    expect(isTrusted(trust, "ops", null)).toBe(false);
  });

  it("addTrust persists and dedupes", () => {
    const p = join(dir, "trust.json");
    const a = addTrust(p, { source: "ops", surfaceId: "d1" });
    expect(a).toEqual([{ source: "ops", surfaceId: "d1" }]);
    const b = addTrust(p, { source: "ops", surfaceId: "d1" }); // dup
    expect(b).toEqual([{ source: "ops", surfaceId: "d1" }]);
    const c = addTrust(p, { source: "ops", surfaceId: "d2" });
    expect(c).toHaveLength(2);
    expect(loadTrust(p)).toEqual(c);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/audit-trust.test.ts`
Expected: FAIL — cannot resolve the new modules.

- [ ] **Step 3: Create `dashboard-host/src/data/audit.ts`**

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEntry } from "./types.js";

export function appendAudit(path: string, entry: AuditEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n");
}
```

- [ ] **Step 4: Create `dashboard-host/src/data/trust.ts`**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface TrustPair {
  source: string;
  surfaceId: string;
}

export function loadTrust(path: string): TrustPair[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is TrustPair =>
        typeof p === "object" && p !== null &&
        typeof (p as TrustPair).source === "string" &&
        typeof (p as TrustPair).surfaceId === "string",
    );
  } catch {
    return [];
  }
}

export function isTrusted(trust: TrustPair[], source: string, surfaceId: string | null): boolean {
  if (surfaceId === null) return false;
  return trust.some((p) => p.source === source && p.surfaceId === surfaceId);
}

export function addTrust(path: string, pair: TrustPair): TrustPair[] {
  const current = loadTrust(path);
  if (current.some((p) => p.source === pair.source && p.surfaceId === pair.surfaceId)) {
    return current;
  }
  const next = [...current, pair];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2));
  return next;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/audit-trust.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add dashboard-host/src/data/audit.ts dashboard-host/src/data/trust.ts dashboard-host/test/audit-trust.test.ts
git commit -m "feat(dashboard-host): append-only audit log and persisted trust store"
```

---

### Task 4: Pending-write queue + write execution (fake executor)

**Files:**
- Create: `dashboard-host/src/data/writes.ts`
- Test: `dashboard-host/test/writes.test.ts`

**Interfaces:**
- Consumes: `DataOp`, `QueryExecutor`, `PendingWrite`, `AuditEntry` (Task 1); `buildSql` (Task 2).
- Produces:
  - `executeWrite(deps: WriteDeps, source: string, op: DataOp, surfaceId: string | null): Promise<{ rowCount: number }>` — runs `buildSql` → `executor.run`, appends an `executed` (or `error`) audit line; returns the rowCount.
  - `class PendingQueue` with: `constructor(deps: WriteDeps)`; `enqueue(source, op, surfaceId): PendingWrite`; `get(pendingId): { status: "pending" | "executed" | "denied"; result?: { rowCount: number } } | undefined`; `list(): PendingWrite[]`; `resolve(pendingId, decision: "approve" | "deny"): Promise<void>`; `subscribe(fn: (kind: "added" | "resolved", w: PendingWrite) => void): () => void`.
  - `interface WriteDeps { executor: QueryExecutor; auditPath: string; now: () => string; id: () => string }`.

- [ ] **Step 1: Write the failing test** — `dashboard-host/test/writes.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWrite, PendingQueue, type WriteDeps } from "../src/data/writes.js";
import type { QueryExecutor, DataOp } from "../src/data/types.js";

let dir: string;
let calls: { text: string; params: unknown[] }[];
const fakeExecutor: QueryExecutor = {
  async run(sql) { calls.push(sql); return { rows: [], rowCount: 3 }; },
};
let n: number;
function deps(): WriteDeps {
  return { getExecutor: () => fakeExecutor, auditPath: join(dir, "audit.jsonl"), now: () => "T", id: () => `p${++n}` };
}
const op: DataOp = { kind: "delete", table: "t", where: { id: 1 } };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-w-")); calls = []; n = 0; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("executeWrite", () => {
  it("runs parameterized SQL and audits an executed write", async () => {
    const d = deps();
    const r = await executeWrite(d, "ops", op, "d1");
    expect(r.rowCount).toBe(3);
    expect(calls[0]).toEqual({ text: 'DELETE FROM "t" WHERE "id" = $1', params: [1] });
    const line = JSON.parse(readFileSync(d.auditPath, "utf8").trim());
    expect(line).toMatchObject({ source: "ops", surfaceId: "d1", decision: "executed", rowCount: 3 });
  });

  it("audits an error and rethrows when the executor fails", async () => {
    const failing: QueryExecutor = { async run() { throw new Error("boom"); } };
    const d = { ...deps(), getExecutor: () => failing };
    await expect(executeWrite(d, "ops", op, "d1")).rejects.toThrow("boom");
    const line = JSON.parse(readFileSync(d.auditPath, "utf8").trim());
    expect(line).toMatchObject({ decision: "error", error: "boom" });
  });
});

describe("PendingQueue", () => {
  it("enqueues, lists, and exposes pending status", () => {
    const q = new PendingQueue(deps());
    const w = q.enqueue("ops", op, "d1");
    expect(w).toMatchObject({ pendingId: "p1", source: "ops", surfaceId: "d1", createdAt: "T" });
    expect(q.list()).toHaveLength(1);
    expect(q.get("p1")).toEqual({ status: "pending" });
  });

  it("resolve approve executes, audits, and flips status to executed", async () => {
    const d = deps();
    const q = new PendingQueue(d);
    q.enqueue("ops", op, "d1");
    await q.resolve("p1", "approve");
    expect(calls).toHaveLength(1);
    expect(q.get("p1")).toEqual({ status: "executed", result: { rowCount: 3 } });
    expect(existsSync(d.auditPath)).toBe(true);
  });

  it("resolve deny audits and flips status to denied without executing", async () => {
    const d = deps();
    const q = new PendingQueue(d);
    q.enqueue("ops", op, "d1");
    await q.resolve("p1", "deny");
    expect(calls).toHaveLength(0);
    expect(q.get("p1")).toEqual({ status: "denied" });
    const line = JSON.parse(readFileSync(d.auditPath, "utf8").trim());
    expect(line.decision).toBe("denied");
  });

  it("notifies subscribers on add and resolve", async () => {
    const q = new PendingQueue(deps());
    const events: string[] = [];
    q.subscribe((kind) => events.push(kind));
    q.enqueue("ops", op, "d1");
    await q.resolve("p1", "deny");
    expect(events).toEqual(["added", "resolved"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/writes.test.ts`
Expected: FAIL — cannot resolve `../src/data/writes.js`.

- [ ] **Step 3: Create `dashboard-host/src/data/writes.ts`**

```typescript
import { buildSql } from "./sql.js";
import { appendAudit } from "./audit.js";
import type { DataOp, QueryExecutor, PendingWrite } from "./types.js";

export interface WriteDeps {
  getExecutor: (sourceId: string) => QueryExecutor;
  auditPath: string;
  now: () => string;
  id: () => string;
}

export async function executeWrite(
  deps: WriteDeps,
  source: string,
  op: DataOp,
  surfaceId: string | null,
): Promise<{ rowCount: number }> {
  try {
    const result = await deps.getExecutor(source).run(buildSql(op));
    appendAudit(deps.auditPath, {
      ts: deps.now(), source, surfaceId, op, decision: "executed", rowCount: result.rowCount,
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

type Status =
  | { status: "pending" }
  | { status: "executed"; result: { rowCount: number } }
  | { status: "denied" };

type Listener = (kind: "added" | "resolved", w: PendingWrite) => void;

export class PendingQueue {
  private readonly deps: WriteDeps;
  private readonly pending = new Map<string, PendingWrite>();
  private readonly status = new Map<string, Status>();
  private readonly listeners = new Set<Listener>();

  constructor(deps: WriteDeps) {
    this.deps = deps;
  }

  enqueue(source: string, op: DataOp, surfaceId: string | null): PendingWrite {
    const w: PendingWrite = { pendingId: this.deps.id(), source, op, surfaceId, createdAt: this.deps.now() };
    this.pending.set(w.pendingId, w);
    this.status.set(w.pendingId, { status: "pending" });
    for (const fn of this.listeners) fn("added", w);
    return w;
  }

  get(pendingId: string): Status | undefined {
    return this.status.get(pendingId);
  }

  list(): PendingWrite[] {
    return [...this.pending.values()].filter((w) => this.status.get(w.pendingId)?.status === "pending");
  }

  async resolve(pendingId: string, decision: "approve" | "deny"): Promise<void> {
    const w = this.pending.get(pendingId);
    if (!w || this.status.get(pendingId)?.status !== "pending") return;
    if (decision === "approve") {
      const result = await executeWrite(this.deps, w.source, w.op, w.surfaceId);
      this.status.set(pendingId, { status: "executed", result });
    } else {
      appendAudit(this.deps.auditPath, {
        ts: this.deps.now(), source: w.source, surfaceId: w.surfaceId, op: w.op, decision: "denied",
      });
      this.status.set(pendingId, { status: "denied" });
    }
    for (const fn of this.listeners) fn("resolved", w);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/writes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src/data/writes.ts dashboard-host/test/writes.test.ts
git commit -m "feat(dashboard-host): pending-write queue and write execution with audit"
```

---

### Task 5: `/data/*` Express router (fake executor, Supertest)

**Files:**
- Create: `dashboard-host/src/data/router.ts`
- Test: `dashboard-host/test/data-router.test.ts`

**Interfaces:**
- Consumes: `loadDataSources`/`findSource` (Task 1), `buildSql` (Task 2), `loadTrust`/`isTrusted`/`addTrust` (Task 3), `executeWrite`/`PendingQueue` (Task 4); `writeSseEvent` (existing `dashboard-host/src/sse.ts` — note: it is typed for `RegistryEvent`; this router emits a generic shape, so use `res.write(\`data: ${JSON.stringify(...)}\n\n\`)` directly to avoid coupling).
- Produces: `createDataRouter(deps: DataRouterDeps): import("express").Router` mounted at `/data`. `interface DataRouterDeps { sources: DataSource[]; getExecutor: (sourceId: string) => QueryExecutor; queue: PendingQueue; trustPath: string; auditPath: string; now: () => string }`.

Routes (relative to the `/data` mount): `POST /:source/query`, `POST /:source/write`, `GET /pending`, `GET /pending/stream`, `GET /pending/:id`, `POST /pending/:id/resolve`.

- [ ] **Step 1: Write the failing test** — `dashboard-host/test/data-router.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataRouter } from "../src/data/router.js";
import { PendingQueue } from "../src/data/writes.js";
import type { QueryExecutor, DataSource } from "../src/data/types.js";

let dir: string;
let calls: { text: string; params: unknown[] }[];
const executor: QueryExecutor = {
  async run(sql) { calls.push(sql); return { rows: [{ id: 1 }], rowCount: 1 }; },
};
const sources: DataSource[] = [
  { id: "ops", type: "postgres", mode: "read-write", connectionString: "x" },
  { id: "rep", type: "postgres", mode: "read", connectionString: "x" },
];

function app() {
  let n = 0;
  const now = () => "T";
  const getExecutor = () => executor;
  const queue = new PendingQueue({ getExecutor, auditPath: join(dir, "audit.jsonl"), now, id: () => `p${++n}` });
  const router = createDataRouter({
    sources, getExecutor, queue, trustPath: join(dir, "trust.json"), auditPath: join(dir, "audit.jsonl"), now,
  });
  const a = express();
  a.use(express.json());
  a.use("/data", router);
  return a;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-dr-")); calls = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("data router", () => {
  it("query runs a select and returns rows", async () => {
    const res = await request(app()).post("/data/ops/query").send({ op: { kind: "select", table: "t", where: { id: 1 } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [{ id: 1 }] });
    expect(calls[0].text).toContain("SELECT");
  });

  it("query rejects a non-select op", async () => {
    const res = await request(app()).post("/data/ops/query").send({ op: { kind: "delete", table: "t", where: { id: 1 } } });
    expect(res.status).toBe(400);
  });

  it("query 404s an unknown source", async () => {
    const res = await request(app()).post("/data/missing/query").send({ op: { kind: "select", table: "t" } });
    expect(res.status).toBe(404);
  });

  it("write to a read-only source is 403", async () => {
    const res = await request(app()).post("/data/rep/write").send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    expect(res.status).toBe(403);
  });

  it("write from an untrusted surface enqueues a pending write", async () => {
    const res = await request(app())
      .post("/data/ops/write")
      .set("Referer", "http://host/surfaces/d1/index.html")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(res.body.pendingId).toBe("p1");
    expect(calls).toHaveLength(0); // not executed yet
  });

  it("resolve approve executes and the surface poll then sees executed", async () => {
    const a = app();
    const w = await request(a).post("/data/ops/write")
      .set("Referer", "http://host/surfaces/d1/index.html")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    const id = w.body.pendingId;
    const r = await request(a).post(`/data/pending/${id}/resolve`).send({ decision: "approve" });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    const poll = await request(a).get(`/data/pending/${id}`);
    expect(poll.body).toEqual({ status: "executed", result: { rowCount: 1 } });
  });

  it("resolve approve with trustSurface lets the next write execute directly", async () => {
    const a = app();
    const w1 = await request(a).post("/data/ops/write")
      .set("Referer", "http://host/surfaces/d1/x").send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    await request(a).post(`/data/pending/${w1.body.pendingId}/resolve`).send({ decision: "approve", trustSurface: true });
    const w2 = await request(a).post("/data/ops/write")
      .set("Referer", "http://host/surfaces/d1/x").send({ op: { kind: "insert", table: "t", values: { a: 2 } } });
    expect(w2.status).toBe(200);
    expect(w2.body.status).toBe("executed");
  });

  it("GET /pending lists pending writes", async () => {
    const a = app();
    await request(a).post("/data/ops/write").set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    const res = await request(a).get("/data/pending");
    expect(res.body.pending).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/data-router.test.ts`
Expected: FAIL — cannot resolve `../src/data/router.js`.

- [ ] **Step 3: Create `dashboard-host/src/data/router.ts`**

```typescript
import express, { type Router, type Request, type Response } from "express";
import { findSource } from "./sources.js";
import { executeWrite, type PendingQueue } from "./writes.js";
import { loadTrust, isTrusted, addTrust } from "./trust.js";
import type { DataSource, DataOp, QueryExecutor } from "./types.js";

export interface DataRouterDeps {
  sources: DataSource[];
  getExecutor: (sourceId: string) => QueryExecutor;
  queue: PendingQueue;
  trustPath: string;
  auditPath: string;
  now: () => string;
}

function surfaceIdFromReferer(req: Request): string | null {
  const ref = req.get("referer") ?? "";
  const m = ref.match(/\/surfaces\/([A-Za-z0-9._-]+)(?:\/|$)/);
  return m ? m[1] : null;
}

export function createDataRouter(deps: DataRouterDeps): Router {
  const router = express.Router();

  router.post("/:source/query", async (req: Request, res: Response) => {
    const source = findSource(deps.sources, req.params.source);
    if (!source) return void res.sendStatus(404);
    const op = req.body?.op as DataOp | undefined;
    if (!op || op.kind !== "select") return void res.status(400).json({ error: "query requires a select op" });
    try {
      const { buildSql } = await import("./sql.js");
      const result = await deps.getExecutor(source.id).run(buildSql(op));
      res.json({ rows: result.rows });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "query failed" });
    }
  });

  router.post("/:source/write", async (req: Request, res: Response) => {
    const source = findSource(deps.sources, req.params.source);
    if (!source) return void res.sendStatus(404);
    if (source.mode !== "read-write") return void res.status(403).json({ error: "source is read-only" });
    const op = req.body?.op as DataOp | undefined;
    if (!op || op.kind === "select") return void res.status(400).json({ error: "write requires a mutating op" });
    const surfaceId = surfaceIdFromReferer(req);

    if (isTrusted(loadTrust(deps.trustPath), source.id, surfaceId)) {
      try {
        const result = await executeWrite(
          { getExecutor: deps.getExecutor, auditPath: deps.auditPath, now: deps.now, id: () => "" },
          source.id, op, surfaceId,
        );
        return void res.json({ status: "executed", result });
      } catch (err) {
        return void res.status(500).json({ error: err instanceof Error ? err.message : "write failed" });
      }
    }
    const w = deps.queue.enqueue(source.id, op, surfaceId);
    res.status(202).json({ pendingId: w.pendingId, status: "pending" });
  });

  router.get("/pending", (_req, res) => {
    res.json({ pending: deps.queue.list() });
  });

  router.get("/pending/stream", (req: Request, res: Response) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders?.();
    for (const w of deps.queue.list()) res.write(`data: ${JSON.stringify({ type: "added", write: w })}\n\n`);
    const unsub = deps.queue.subscribe((kind, w) => res.write(`data: ${JSON.stringify({ type: kind, write: w })}\n\n`));
    req.on("close", unsub);
  });

  router.get("/pending/:id", (req: Request, res: Response) => {
    const status = deps.queue.get(req.params.id);
    if (!status) return void res.sendStatus(404);
    res.json(status);
  });

  router.post("/pending/:id/resolve", async (req: Request, res: Response) => {
    const { decision, trustSurface } = req.body ?? {};
    if (decision !== "approve" && decision !== "deny") return void res.status(400).json({ error: "bad decision" });
    const pending = deps.queue.list().find((w) => w.pendingId === req.params.id);
    try {
      await deps.queue.resolve(req.params.id, decision);
    } catch (err) {
      return void res.status(500).json({ error: err instanceof Error ? err.message : "resolve failed" });
    }
    if (decision === "approve" && trustSurface && pending?.surfaceId) {
      addTrust(deps.trustPath, { source: pending.source, surfaceId: pending.surfaceId });
    }
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/data-router.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src/data/router.ts dashboard-host/test/data-router.test.ts
git commit -m "feat(dashboard-host): /data routes with query, mediated write, and resolve"
```

---

### Task 6: Postgres executor + mount into the dashboard host

**Files:**
- Create: `dashboard-host/src/data/pgExecutor.ts`
- Modify: `dashboard-host/package.json` (add `pg`), `dashboard-host/src/config.ts` (data paths), `dashboard-host/src/index.ts` (wire the router)
- Test: `dashboard-host/test/index.smoke.test.ts` (extend to assert `/data/pending` is mounted with a fake executor)

**Interfaces:**
- Consumes: everything above.
- Produces: `createPgExecutor(source: DataSource): QueryExecutor` — wraps one `pg.Pool` bound to that source's `connectionString`. The `buildApp` wiring (Step 4) calls it once per source id and caches the result, so each source gets its own pool. Build-verified; the live run exercises the real connection.

- [ ] **Step 1: Add `pg`**

In `dashboard-host/package.json` add to `dependencies`: `"pg": "^8.12.0"`, and to `devDependencies`: `"@types/pg": "^8.11.0"`.
Run: `cd dashboard-host && npm install`
Expected: exit 0.

- [ ] **Step 2: Create `dashboard-host/src/data/pgExecutor.ts`**

```typescript
import pg from "pg";
import type { DataSource, QueryExecutor } from "./types.js";

// One executor bound to a single source's pool. The router holds one executor
// per source id (constructed by the caller); see index.ts wiring.
export function createPgExecutor(source: DataSource): QueryExecutor {
  const pool = new pg.Pool({ connectionString: source.connectionString });
  return {
    async run(sql) {
      const result = await pool.query(sql.text, sql.params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
    },
  };
}
```

- [ ] **Step 3: Add data paths to `dashboard-host/src/config.ts`**

Add three fields to the `Config` interface:

```typescript
  dataSourcesPath: string;
  dataTrustPath: string;
  dataAuditPath: string;
```

In `loadConfig`, the current code computes `workspace` inline in the return. Extract it to a `const` and add the three data paths (each env-overridable, defaulting under the workspace). Replace the existing return:

```typescript
  const workspace = env.RHUMBR_WORKSPACE?.trim() || "./workspace";
  return {
    port,
    workspace,
    dataSourcesPath: env.RHUMBR_DATA_SOURCES?.trim() || `${workspace}/data-sources.json`,
    dataTrustPath: env.RHUMBR_DATA_TRUST?.trim() || `${workspace}/data-trust.json`,
    dataAuditPath: env.RHUMBR_DATA_AUDIT?.trim() || `${workspace}/data-audit.jsonl`,
  };
```

Then update both `toEqual(...)` cases in `dashboard-host/test/config.test.ts`:
- empty-env / defaults case → add `dataSourcesPath: "./workspace/data-sources.json"`, `dataTrustPath: "./workspace/data-trust.json"`, `dataAuditPath: "./workspace/data-audit.jsonl"`.
- the override case (which sets `RHUMBR_WORKSPACE: "/srv/ws"`) → add `dataSourcesPath: "/srv/ws/data-sources.json"`, `dataTrustPath: "/srv/ws/data-trust.json"`, `dataAuditPath: "/srv/ws/data-audit.jsonl"`.

- [ ] **Step 4: Wire the router in `dashboard-host/src/index.ts`**

`buildApp` gains an optional `executorFor` (defaults to `createPgExecutor`) so the smoke test can inject a fake. It builds the declared sources, a per-source executor cache, the pending queue, and mounts the `/data` router. Add the imports and the data-layer wiring; keep all existing registry/server wiring unchanged.

Add imports:

```typescript
import { loadDataSources } from "./data/sources.js";
import { createPgExecutor } from "./data/pgExecutor.js";
import { PendingQueue } from "./data/writes.js";
import { createDataRouter } from "./data/router.js";
import type { QueryExecutor, DataSource } from "./data/types.js";
```

Change the `buildApp` signature and, after the Express app is created (and `app.use(express.json())` is in place — add it if the existing app doesn't already parse JSON), insert the data wiring:

```typescript
export function buildApp(deps: {
  config: Config;
  watch: WatchFn;
  executorFor?: (source: DataSource) => QueryExecutor;
}): Express {
  // ...existing registry store + watcher + createServer wiring stays exactly as-is...

  const app = /* the existing Express app from createServer */;
  app.use(express.json()); // ensure JSON body parsing for /data routes

  const sources = loadDataSources(deps.config.dataSourcesPath);
  const executorFor = deps.executorFor ?? createPgExecutor;
  const executorCache = new Map<string, QueryExecutor>();
  const getExecutor = (sourceId: string): QueryExecutor => {
    let ex = executorCache.get(sourceId);
    if (!ex) {
      const src = sources.find((s) => s.id === sourceId);
      if (!src) throw new Error(`unknown source: ${sourceId}`);
      ex = executorFor(src);
      executorCache.set(sourceId, ex);
    }
    return ex;
  };

  const now = () => new Date().toISOString();
  const queue = new PendingQueue({ getExecutor, auditPath: deps.config.dataAuditPath, now, id: () => crypto.randomUUID() });

  app.use(
    "/data",
    createDataRouter({
      sources,
      getExecutor,
      queue,
      trustPath: deps.config.dataTrustPath,
      auditPath: deps.config.dataAuditPath,
      now,
    }),
  );

  return app;
}
```

> If `createServer` currently builds and returns the app internally, expose the app to `buildApp` so it can `app.use("/data", …)` before returning — e.g. have `createServer` return the app and let `buildApp` mount the data router on it. Do not duplicate the registry routes.

- [ ] **Step 5: Extend the smoke test** — in `dashboard-host/test/index.smoke.test.ts`, add a case that builds the app with a fake `executorFor` and a temp `data-sources.json` containing one `read-write` source, then asserts `GET /data/pending` returns `{ pending: [] }` (proves the router is mounted):

```typescript
  it("mounts the data router", async () => {
    // write a data-sources.json into the temp workspace with one source
    const dir = join(workspace, ""); // workspace from the existing beforeEach
    writeFileSync(join(workspace, "data-sources.json"), JSON.stringify([
      { id: "ops", type: "postgres", mode: "read-write", connectionString: "x" },
    ]));
    const app = buildApp({
      config: {
        port: 0, workspace,
        dataSourcesPath: join(workspace, "data-sources.json"),
        dataTrustPath: join(workspace, "data-trust.json"),
        dataAuditPath: join(workspace, "data-audit.jsonl"),
      } as never,
      watch: () => ({ close() {} }),
      executorFor: () => ({ async run() { return { rows: [], rowCount: 0 }; } }),
    });
    const res = await request(app).get("/data/pending");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: [] });
  });
```

(Adjust the existing smoke test's `buildApp` config object to include the three data path fields so it still typechecks.)

- [ ] **Step 6: Build + full suite + typecheck**

Run: `cd dashboard-host && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS; `tsc` clean.

- [ ] **Step 7: Commit**

```bash
git add dashboard-host/package.json dashboard-host/package-lock.json dashboard-host/src/data/pgExecutor.ts dashboard-host/src/config.ts dashboard-host/src/index.ts dashboard-host/test/config.test.ts dashboard-host/test/index.smoke.test.ts
git commit -m "feat(dashboard-host): Postgres executor and mounted /data router"
```

---

### Task 7: Client carry-in cleanups (SSE UTF-8 + bundle identifier)

**Files:**
- Modify: `client/src-tauri/src/proxy.rs` (byte-buffered UTF-8 decode), `client/src-tauri/tauri.conf.json` (identifier)
- Test: a Rust unit test in `proxy.rs`

**Interfaces:**
- Produces: a small `decode_chunks` helper (or an inline byte buffer) so a multibyte UTF-8 char split across two stream chunks is not dropped.

- [ ] **Step 1: Add a failing Rust test for split-multibyte decoding** — in `client/src-tauri/src/proxy.rs`, add a pure helper and test. Add near the top:

```rust
/// Accumulates raw bytes and yields the largest valid UTF-8 prefix as a String,
/// keeping any trailing incomplete multibyte sequence buffered for the next call.
pub struct Utf8Buffer {
    buf: Vec<u8>,
}

impl Utf8Buffer {
    pub fn new() -> Self {
        Utf8Buffer { buf: Vec::new() }
    }

    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.buf.extend_from_slice(bytes);
        match std::str::from_utf8(&self.buf) {
            Ok(s) => {
                let out = s.to_string();
                self.buf.clear();
                out
            }
            Err(e) => {
                let valid = e.valid_up_to();
                let out = String::from_utf8_lossy(&self.buf[..valid]).to_string();
                self.buf.drain(..valid);
                out
            }
        }
    }
}

#[cfg(test)]
mod utf8_tests {
    use super::*;

    #[test]
    fn reassembles_a_multibyte_char_split_across_chunks() {
        // '✅' is E2 9C 85
        let mut b = Utf8Buffer::new();
        assert_eq!(b.push(&[0xE2, 0x9C]), ""); // incomplete, nothing yet
        assert_eq!(b.push(&[0x85]), "✅");
    }

    #[test]
    fn passes_ascii_through() {
        let mut b = Utf8Buffer::new();
        assert_eq!(b.push(b"data: 1\n\n"), "data: 1\n\n");
    }
}
```

- [ ] **Step 2: Run to verify it fails (compile error: type not yet used / or test passes once added)**

Run: `cd client/src-tauri && cargo test utf8`
Expected: the two `utf8_tests` compile and PASS (this helper is self-contained). If they don't compile, fix until they pass.

- [ ] **Step 3: Use `Utf8Buffer` in the `pump` loop** — in `proxy.rs`, replace the per-chunk `std::str::from_utf8(&bytes)` decode with the buffered decode. In `pump`, change:

```rust
    let mut parser = SseParser::new();
    loop {
        tokio::select! {
            _ = token.cancelled() => break,
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            for payload in parser.push(text) {
                                if let Ok(v) = serde_json::from_str::<Value>(&payload) {
                                    let _ = on_event.send(v);
                                }
                            }
                        }
                    }
                    _ => break,
                }
            }
        }
    }
```

to:

```rust
    let mut parser = SseParser::new();
    let mut decoder = Utf8Buffer::new();
    loop {
        tokio::select! {
            _ = token.cancelled() => break,
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        let text = decoder.push(&bytes);
                        for payload in parser.push(&text) {
                            if let Ok(v) = serde_json::from_str::<Value>(&payload) {
                                let _ = on_event.send(v);
                            }
                        }
                    }
                    _ => break,
                }
            }
        }
    }
```

- [ ] **Step 4: Rename the bundle identifier** — in `client/src-tauri/tauri.conf.json`, change `"identifier": "com.tauri.dev"` to `"identifier": "com.rhumbr.client"`.

- [ ] **Step 5: Build + test**

Run: `cd client/src-tauri && cargo test && cargo build`
Expected: all Rust tests (sse + config + utf8) PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add client/src-tauri/src/proxy.rs client/src-tauri/tauri.conf.json
git commit -m "fix(client): byte-buffered SSE UTF-8 decode and real bundle identifier"
```

---

### Task 8: Client Rust pending commands + IPC wrappers

**Files:**
- Modify: `client/src-tauri/src/proxy.rs` (pending stream + resolve commands), `client/src-tauri/src/lib.rs` (register), `client/src-tauri/src/proxy.rs` `StreamState` (add a pending slot)
- Modify: `client/src/lib/tauri.ts` (wrappers)

**Interfaces:**
- Produces (Rust): `start_pending_stream(state, dashboard_base, on_pending: Channel<Value>)`, `stop_pending_stream(state)`, `resolve_pending(dashboard_base, pending_id, decision, trust_surface) -> Result<(), String>`.
- Produces (TS): `openPendingStream(dashboardBase, onPending: (e: unknown) => void): () => void`, `resolvePending(dashboardBase, pendingId, decision: "approve" | "deny", trustSurface: boolean): Promise<void>`.

This task is build-verified (the pump + Channel patterns are already tested via Task 7 and the existing streams).

- [ ] **Step 1: Add a `pending` slot to `StreamState`** in `proxy.rs`:

```rust
#[derive(Default)]
pub struct StreamState {
    pub agent: Mutex<HashMap<String, CancellationToken>>,
    pub registry: Mutex<Option<CancellationToken>>,
    pub pending: Mutex<Option<CancellationToken>>,
}
```

- [ ] **Step 2: Add the pending commands** in `proxy.rs` (mirror the registry stream + a POST):

```rust
#[tauri::command]
pub async fn start_pending_stream(
    state: tauri::State<'_, StreamState>,
    dashboard_base: String,
    on_pending: Channel<Value>,
) -> Result<(), String> {
    let token = CancellationToken::new();
    if let Some(old) = state.pending.lock().unwrap().replace(token.clone()) {
        old.cancel();
    }
    let url = format!("{}/data/pending/stream", dashboard_base.trim_end_matches('/'));
    tokio::spawn(async move { pump(url, on_pending, token).await });
    Ok(())
}

#[tauri::command]
pub fn stop_pending_stream(state: tauri::State<'_, StreamState>) {
    if let Some(tok) = state.pending.lock().unwrap().take() {
        tok.cancel();
    }
}

#[tauri::command]
pub async fn resolve_pending(
    dashboard_base: String,
    pending_id: String,
    decision: String,
    trust_surface: bool,
) -> Result<(), String> {
    let url = format!("{}/data/pending/{}/resolve", dashboard_base.trim_end_matches('/'), pending_id);
    reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "decision": decision, "trustSurface": trust_surface }))
        .send()
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Register the three commands** in `client/src-tauri/src/lib.rs` — add `start_pending_stream`, `stop_pending_stream`, `resolve_pending` to the existing `generate_handler![...]`.

- [ ] **Step 4: Add TS wrappers** to `client/src/lib/tauri.ts`:

```typescript
export function openPendingStream(
  dashboardBase: string,
  onPending: (e: unknown) => void,
): () => void {
  const channel = new Channel<unknown>();
  channel.onmessage = onPending;
  void invoke("start_pending_stream", { dashboardBase, onPending: channel });
  return () => void invoke("stop_pending_stream");
}

export function resolvePending(
  dashboardBase: string,
  pendingId: string,
  decision: "approve" | "deny",
  trustSurface: boolean,
): Promise<void> {
  return invoke("resolve_pending", { dashboardBase, pendingId, decision, trustSurface });
}
```

- [ ] **Step 5: Build + typecheck**

Run: `cd client && npx tsc -p tsconfig.json --noEmit && cd src-tauri && cargo build`
Expected: `tsc` clean; `cargo build` clean.

- [ ] **Step 6: Commit**

```bash
git add client/src-tauri/src/proxy.rs client/src-tauri/src/lib.rs client/src/lib/tauri.ts
git commit -m "feat(client): pending-write stream and resolve IPC"
```

---

### Task 9: `pendingStore` reducer + ConfirmationDialog + wiring

**Files:**
- Create: `client/src/lib/pendingStore.ts`, `client/src/components/ConfirmationDialog.tsx`
- Modify: `client/src/App.tsx` (render the dialog)
- Test: `client/test/pendingStore.test.ts`, `client/test/ConfirmationDialog.test.tsx`

**Interfaces:**
- Produces (`pendingStore.ts`): `interface PendingItem { pendingId: string; source: string; op: unknown; surfaceId: string | null }`; `reducePending(list: PendingItem[], event: unknown): PendingItem[]` — an `{type:"added", write}` appends (dedupe by pendingId); `{type:"resolved", write}` removes by pendingId; anything else returns the list unchanged.
- Produces (`ConfirmationDialog.tsx`): `<ConfirmationDialog dashboardBase={string} />` — subscribes to `openPendingStream`, shows the first pending item with Approve/Deny + a "trust this surface" checkbox calling `resolvePending`.

- [ ] **Step 1: Write the failing reducer test** — `client/test/pendingStore.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { reducePending, type PendingItem } from "../src/lib/pendingStore";

const write = (id: string) => ({ pendingId: id, source: "ops", op: { kind: "insert" }, surfaceId: "d1" });

describe("reducePending", () => {
  it("adds on an added event", () => {
    const list = reducePending([], { type: "added", write: write("p1") });
    expect(list.map((x: PendingItem) => x.pendingId)).toEqual(["p1"]);
  });

  it("dedupes by pendingId", () => {
    const list = reducePending([write("p1")], { type: "added", write: write("p1") });
    expect(list).toHaveLength(1);
  });

  it("removes on a resolved event", () => {
    const list = reducePending([write("p1"), write("p2")], { type: "resolved", write: write("p1") });
    expect(list.map((x: PendingItem) => x.pendingId)).toEqual(["p2"]);
  });

  it("ignores unknown events", () => {
    const before = [write("p1")];
    expect(reducePending(before, { type: "junk" })).toBe(before);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run test/pendingStore.test.ts`
Expected: FAIL — cannot resolve `../src/lib/pendingStore`.

- [ ] **Step 3: Create `client/src/lib/pendingStore.ts`**

```typescript
export interface PendingItem {
  pendingId: string;
  source: string;
  op: unknown;
  surfaceId: string | null;
}

export function reducePending(list: PendingItem[], event: unknown): PendingItem[] {
  if (typeof event !== "object" || event === null) return list;
  const e = event as { type?: string; write?: PendingItem };
  if (e.type === "added" && e.write) {
    if (list.some((x) => x.pendingId === e.write!.pendingId)) return list;
    return [...list, e.write];
  }
  if (e.type === "resolved" && e.write) {
    return list.filter((x) => x.pendingId !== e.write!.pendingId);
  }
  return list;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && npx vitest run test/pendingStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing dialog test** — `client/test/ConfirmationDialog.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmationDialog } from "../src/components/ConfirmationDialog";

let capturedOnPending: ((e: unknown) => void) | null = null;
const resolveSpy = vi.fn();

vi.mock("../src/lib/tauri", () => ({
  openPendingStream: vi.fn((_base: string, onPending: (e: unknown) => void) => {
    capturedOnPending = onPending;
    return () => {};
  }),
  resolvePending: (...args: unknown[]) => resolveSpy(...args),
}));

describe("ConfirmationDialog", () => {
  beforeEach(() => { vi.clearAllMocks(); capturedOnPending = null; });

  it("shows a pending write and approves with trust", async () => {
    render(<ConfirmationDialog dashboardBase="http://d:8788" />);
    capturedOnPending?.({ type: "added", write: { pendingId: "p1", source: "ops", op: { kind: "insert", table: "t" }, surfaceId: "d1" } });

    expect(await screen.findByText(/ops/)).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/trust this surface/i));
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(resolveSpy).toHaveBeenCalledWith("http://d:8788", "p1", "approve", true);
  });

  it("denies without trust", async () => {
    render(<ConfirmationDialog dashboardBase="http://d:8788" />);
    capturedOnPending?.({ type: "added", write: { pendingId: "p2", source: "ops", op: { kind: "delete", table: "t" }, surfaceId: "d1" } });
    await screen.findByText(/ops/);
    await userEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(resolveSpy).toHaveBeenCalledWith("http://d:8788", "p2", "deny", false);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd client && npx vitest run test/ConfirmationDialog.test.tsx`
Expected: FAIL — cannot resolve `../src/components/ConfirmationDialog`.

- [ ] **Step 7: Create `client/src/components/ConfirmationDialog.tsx`**

```tsx
import { useEffect, useState } from "react";
import { reducePending, type PendingItem } from "../lib/pendingStore";
import { openPendingStream, resolvePending } from "../lib/tauri";

export function ConfirmationDialog({ dashboardBase }: { dashboardBase: string }) {
  const [queue, setQueue] = useState<PendingItem[]>([]);
  const [trust, setTrust] = useState(false);

  useEffect(() => {
    const stop = openPendingStream(dashboardBase, (event) => {
      setQueue((prev) => reducePending(prev, event));
    });
    return stop;
  }, [dashboardBase]);

  const current = queue[0];
  if (!current) return null;

  async function decide(decision: "approve" | "deny") {
    await resolvePending(dashboardBase, current.pendingId, decision, decision === "approve" && trust);
    setQueue((prev) => prev.filter((x) => x.pendingId !== current.pendingId));
    setTrust(false);
  }

  return (
    <div role="dialog" aria-label="Confirm write" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", color: "#111", padding: 20, borderRadius: 8, maxWidth: 480 }}>
        <h2>Confirm write to “{current.source}”</h2>
        <p>Surface: {current.surfaceId ?? "unknown"}</p>
        <pre style={{ background: "#f3f4f6", padding: 8, overflow: "auto" }}>{JSON.stringify(current.op, null, 2)}</pre>
        <label>
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} /> Trust this surface
        </label>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button onClick={() => decide("approve")}>Approve</button>
          <button onClick={() => decide("deny")}>Deny</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `cd client && npx vitest run test/ConfirmationDialog.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 9: Render the dialog in `client/src/App.tsx`** — inside the connected branch, render it alongside `Workspace` so it overlays regardless of the active tab:

```tsx
  return (
    <>
      <Workspace agentBase={config.agentBase} dashboardBase={config.dashboardBase} />
      <ConfirmationDialog dashboardBase={config.dashboardBase} />
    </>
  );
```

(Add `import { ConfirmationDialog } from "./components/ConfirmationDialog";` at the top.)

- [ ] **Step 10: Full client suite + typecheck**

Run: `cd client && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS; `tsc` clean.

- [ ] **Step 11: Commit**

```bash
git add client/src/lib/pendingStore.ts client/src/components/ConfirmationDialog.tsx client/src/App.tsx client/test/pendingStore.test.ts client/test/ConfirmationDialog.test.tsx
git commit -m "feat(client): write-confirmation dialog driven by the pending stream"
```

---

## Done criteria (automated)

- `cd dashboard-host && npx vitest run && npx tsc -p tsconfig.json --noEmit` — pass (data layer + router + mount).
- `cd client && npx vitest run && npx tsc -p tsconfig.json --noEmit` — pass (pendingStore + dialog).
- `cd client/src-tauri && cargo test && cargo build` — pass (utf8 + sse + config; whole shell compiles).

## Live verification (driver-run, against a real Postgres)

1. Create a Postgres DB and a table; add it to `<workspace>/data-sources.json` as a `read-write` source.
2. Run the hosts + the client (as in Plan 3b). Have the agent (or a hand-written surface) build a surface that `select`s rows → confirm live data renders.
3. From that surface, issue an `insert`/`update` → confirm the **confirmation dialog** appears in the client → Approve → the row changes in Postgres and a line lands in `data-audit.jsonl`.
4. Re-issue a write with "trust this surface" checked → confirm the next write executes without a dialog. Confirm a `read`-mode source rejects writes (403).

## Next plan

**Plan 5 — Infrastructure capability:** Proxmox VM lifecycle + database provisioning as agent tools (gated, audited). Provisioned databases auto-register as declared data sources here, closing the create-DB → wire-a-dashboard loop.
