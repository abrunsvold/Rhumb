# RHUMBR Infrastructure Capability Implementation Plan (Plan 5 of 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent operator-confirmed, audited tools to provision PostgreSQL databases (auto-registering as Plan-4 data sources) and run the full Proxmox VM lifecycle, gated through the Agent SDK's `canUseTool` callback and surfaced in the desktop client.

**Architecture:** The agent host gains an in-process `infra` MCP server (Agent SDK `createSdkMcpServer`). Read tools are allowlisted; destructive/provisioning tools are left out of `allowedTools` so the agent host's `canUseTool` callback gates them via a pending-action queue the client confirms over `/infra/pending*`. Proxmox and PG-admin live behind injectable seams so the logic is unit-tested; the real paths are live-verified.

**Tech Stack:** TypeScript (strict), Node ≥ 20, Express 4, `@anthropic-ai/claude-agent-sdk`, `zod`, `pg`, Vitest + Supertest (agent host); Tauri v2 Rust + React (client).

## Global Constraints

- **Grounded Agent SDK facts:** in-process tools via `createSdkMcpServer({name,version,tools})` + `tool(name, desc, zodSchema, handler)`; wire into `query` via `options.mcpServers = { infra: server }`; tool names are `mcp__infra__<tool>`. A tool NOT in `allowedTools` (with `permissionMode` default-ish) routes to `canUseTool(toolName, input, opts) => { behavior:"allow", updatedInput } | { behavior:"deny", message }`, which may await an async decision. Auto-approved tools never reach `canUseTool`.
- **Gating split:** read tools (`mcp__infra__list_vms`, `mcp__infra__vm_status`) go in `allowedTools`. Gated tools (`create_vm`, `start_vm`, `stop_vm`, `resize_vm`, `destroy_vm`, `provision_database`) are omitted → confirmed via the pending-action queue. The `canUseTool` callback **passes through (allows) every non-gated tool** so the agent's existing surface-building autonomy is preserved.
- **No raw SQL / shell from inputs:** `provision_database` validates the db/role identifiers against `^[A-Za-z_][A-Za-z0-9_]*$` and quotes them; no value interpolation.
- **Seams:** `interface ProxmoxClient` and `interface AdminExecutor` (PG admin) are the only code that touches the real Proxmox/Postgres; everything else depends on the interfaces and is unit-tested with fakes. The real implementations are build-verified + live-verified.
- **Audit:** every gated action (approved/denied/error) appends to `RHUMBR_INFRA_AUDIT` (default `<workspace>/infra-audit.jsonl`).
- **Credentials** (scoped Proxmox token, PG admin connection) live only on the agent host. The client receives only the pending action's `{tool, input}` for display.
- **Node ≥ 20, TS strict, ES modules; agent-host/dashboard-host imports use `.js`; client (Vite) imports use no suffix.**
- **Reuse:** the agent host's `writeSseEvent`/SSE pattern and the client's Channel proxy + the generalized confirmation surface (extends Plan 4).

---

### Task 1: Infra config + audit

**Files:**
- Create: `agent-host/src/infra/types.ts`, `agent-host/src/infra/config.ts`, `agent-host/src/infra/audit.ts`
- Test: `agent-host/test/infra-config.test.ts`

**Interfaces:**
- Produces (`types.ts`): `InfraConfig`, `PendingAction`, `InfraAuditEntry`, `ProxmoxClient`, `AdminExecutor`, `Vm`, `VmStatus`, `DataSourceEntry`.
- Produces (`config.ts`): `loadInfraConfig(env): InfraConfig` (paths + optional proxmox/pg-admin settings; missing optional fields → undefined, never throws).
- Produces (`audit.ts`): `appendInfraAudit(path: string, entry: InfraAuditEntry): void`.

- [ ] **Step 1: Create `agent-host/src/infra/types.ts`**

```typescript
export interface InfraConfig {
  auditPath: string;
  dataSourcesPath: string;
  proxmox?: { baseUrl: string; tokenId: string; tokenSecret: string; node: string };
  pgAdmin?: { connectionString: string };
}

export interface Vm { id: number; name: string; status: string }
export interface VmStatus { id: number; status: string; cpus?: number; maxmem?: number }

export interface ProxmoxClient {
  listVms(): Promise<Vm[]>;
  status(id: number): Promise<VmStatus>;
  create(spec: { name: string; cores: number; memory: number }): Promise<{ id: number }>;
  start(id: number): Promise<void>;
  stop(id: number): Promise<void>;
  resize(id: number, spec: { cores?: number; memory?: number }): Promise<void>;
  destroy(id: number): Promise<void>;
}

export interface AdminExecutor {
  exec(sql: string): Promise<void>;
}

export interface DataSourceEntry {
  id: string;
  type: "postgres";
  mode: "read" | "read-write";
  connectionString: string;
}

export type GatedTool =
  | "create_vm" | "start_vm" | "stop_vm" | "resize_vm" | "destroy_vm" | "provision_database";

export interface PendingAction {
  pendingId: string;
  tool: GatedTool;
  input: Record<string, unknown>;
  createdAt: string;
}

export interface InfraAuditEntry {
  ts: string;
  tool: string;
  input: Record<string, unknown>;
  decision: "approved" | "denied" | "error";
  result?: unknown;
  error?: string;
}
```

- [ ] **Step 2: Write the failing test** — `agent-host/test/infra-config.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInfraConfig } from "../src/infra/config.js";
import { appendInfraAudit } from "../src/infra/audit.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-infra-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadInfraConfig", () => {
  it("defaults paths under the workspace and leaves optional creds undefined", () => {
    const cfg = loadInfraConfig({ RHUMBR_WORKSPACE: "/srv/ws" });
    expect(cfg.auditPath).toBe("/srv/ws/infra-audit.jsonl");
    expect(cfg.dataSourcesPath).toBe("/srv/ws/data-sources.json");
    expect(cfg.proxmox).toBeUndefined();
    expect(cfg.pgAdmin).toBeUndefined();
  });

  it("reads proxmox + pg-admin settings when present", () => {
    const cfg = loadInfraConfig({
      RHUMBR_WORKSPACE: "/srv/ws",
      RHUMBR_PROXMOX_URL: "https://pve:8006",
      RHUMBR_PROXMOX_TOKEN_ID: "rhumbr@pve!t1",
      RHUMBR_PROXMOX_TOKEN_SECRET: "secret",
      RHUMBR_PROXMOX_NODE: "pve",
      RHUMBR_PG_ADMIN: "postgres://admin:pw@pg:5432/postgres",
    });
    expect(cfg.proxmox).toEqual({ baseUrl: "https://pve:8006", tokenId: "rhumbr@pve!t1", tokenSecret: "secret", node: "pve" });
    expect(cfg.pgAdmin).toEqual({ connectionString: "postgres://admin:pw@pg:5432/postgres" });
  });
});

describe("appendInfraAudit", () => {
  it("appends JSONL", () => {
    const p = join(dir, "audit.jsonl");
    appendInfraAudit(p, { ts: "t", tool: "destroy_vm", input: { id: 9 }, decision: "denied" });
    expect(JSON.parse(readFileSync(p, "utf8").trim())).toMatchObject({ tool: "destroy_vm", decision: "denied" });
  });
});
```

- [ ] **Step 3: Create `agent-host/src/infra/config.ts`**

```typescript
import type { InfraConfig } from "./types.js";

export function loadInfraConfig(env: NodeJS.ProcessEnv): InfraConfig {
  const workspace = env.RHUMBR_WORKSPACE?.trim() || "./workspace";
  const cfg: InfraConfig = {
    auditPath: env.RHUMBR_INFRA_AUDIT?.trim() || `${workspace}/infra-audit.jsonl`,
    dataSourcesPath: env.RHUMBR_DATA_SOURCES?.trim() || `${workspace}/data-sources.json`,
  };
  const { RHUMBR_PROXMOX_URL, RHUMBR_PROXMOX_TOKEN_ID, RHUMBR_PROXMOX_TOKEN_SECRET, RHUMBR_PROXMOX_NODE } = env;
  if (RHUMBR_PROXMOX_URL && RHUMBR_PROXMOX_TOKEN_ID && RHUMBR_PROXMOX_TOKEN_SECRET && RHUMBR_PROXMOX_NODE) {
    cfg.proxmox = {
      baseUrl: RHUMBR_PROXMOX_URL.trim(),
      tokenId: RHUMBR_PROXMOX_TOKEN_ID.trim(),
      tokenSecret: RHUMBR_PROXMOX_TOKEN_SECRET.trim(),
      node: RHUMBR_PROXMOX_NODE.trim(),
    };
  }
  if (env.RHUMBR_PG_ADMIN?.trim()) cfg.pgAdmin = { connectionString: env.RHUMBR_PG_ADMIN.trim() };
  return cfg;
}
```

- [ ] **Step 4: Create `agent-host/src/infra/audit.ts`**

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { InfraAuditEntry } from "./types.js";

export function appendInfraAudit(path: string, entry: InfraAuditEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n");
}
```

- [ ] **Step 5: Run the test**

Run: `cd agent-host && npx vitest run test/infra-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add agent-host/src/infra/types.ts agent-host/src/infra/config.ts agent-host/src/infra/audit.ts agent-host/test/infra-config.test.ts
git commit -m "feat(agent-host): infra config, types, and audit log"
```

---

### Task 2: Pending-action queue (the gating core)

**Files:**
- Create: `agent-host/src/infra/pending.ts`
- Test: `agent-host/test/infra-pending.test.ts`

**Interfaces:**
- Consumes: `PendingAction`, `GatedTool` (Task 1).
- Produces: `class PendingActions` with:
  - `constructor(deps: { now: () => string; id: () => string })`
  - `enqueue(tool: GatedTool, input: Record<string, unknown>): { action: PendingAction; decision: Promise<"approve" | "deny"> }`
  - `resolve(pendingId: string, decision: "approve" | "deny"): boolean` (true if it resolved a pending one)
  - `list(): PendingAction[]`
  - `subscribe(fn: (kind: "added" | "resolved", a: PendingAction) => void): () => void`

- [ ] **Step 1: Write the failing test** — `agent-host/test/infra-pending.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { PendingActions } from "../src/infra/pending.js";

function mk() {
  let n = 0;
  return new PendingActions({ now: () => "T", id: () => `a${++n}` });
}

describe("PendingActions", () => {
  it("enqueue returns an action and a decision promise that resolves on resolve(approve)", async () => {
    const q = mk();
    const { action, decision } = q.enqueue("destroy_vm", { id: 9 });
    expect(action).toEqual({ pendingId: "a1", tool: "destroy_vm", input: { id: 9 }, createdAt: "T" });
    expect(q.list()).toHaveLength(1);
    q.resolve("a1", "approve");
    expect(await decision).toBe("approve");
    expect(q.list()).toHaveLength(0); // no longer pending
  });

  it("resolve(deny) resolves the promise with deny", async () => {
    const q = mk();
    const { decision } = q.enqueue("provision_database", { name: "x" });
    q.resolve("a1", "deny");
    expect(await decision).toBe("deny");
  });

  it("resolve returns false for an unknown or already-resolved id", () => {
    const q = mk();
    q.enqueue("start_vm", { id: 1 });
    expect(q.resolve("a1", "approve")).toBe(true);
    expect(q.resolve("a1", "deny")).toBe(false);
    expect(q.resolve("nope", "approve")).toBe(false);
  });

  it("notifies subscribers on add and resolve", () => {
    const q = mk();
    const events: string[] = [];
    q.subscribe((k) => events.push(k));
    q.enqueue("stop_vm", { id: 2 });
    q.resolve("a1", "approve");
    expect(events).toEqual(["added", "resolved"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd agent-host && npx vitest run test/infra-pending.test.ts`
Expected: FAIL — cannot resolve `../src/infra/pending.js`.

- [ ] **Step 3: Create `agent-host/src/infra/pending.ts`**

```typescript
import type { PendingAction, GatedTool } from "./types.js";

type Listener = (kind: "added" | "resolved", a: PendingAction) => void;

interface Entry {
  action: PendingAction;
  resolve: (d: "approve" | "deny") => void;
  settled: boolean;
}

export class PendingActions {
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<Listener>();

  constructor(deps: { now: () => string; id: () => string }) {
    this.now = deps.now;
    this.id = deps.id;
  }

  enqueue(tool: GatedTool, input: Record<string, unknown>): { action: PendingAction; decision: Promise<"approve" | "deny"> } {
    const action: PendingAction = { pendingId: this.id(), tool, input, createdAt: this.now() };
    let resolveFn!: (d: "approve" | "deny") => void;
    const decision = new Promise<"approve" | "deny">((res) => { resolveFn = res; });
    this.entries.set(action.pendingId, { action, resolve: resolveFn, settled: false });
    for (const fn of this.listeners) fn("added", action);
    return { action, decision };
  }

  resolve(pendingId: string, decision: "approve" | "deny"): boolean {
    const entry = this.entries.get(pendingId);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    entry.resolve(decision);
    for (const fn of this.listeners) fn("resolved", entry.action);
    return true;
  }

  list(): PendingAction[] {
    return [...this.entries.values()].filter((e) => !e.settled).map((e) => e.action);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd agent-host && npx vitest run test/infra-pending.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/infra/pending.ts agent-host/test/infra-pending.test.ts
git commit -m "feat(agent-host): pending-action queue with awaited decisions"
```

---

### Task 3: DB provisioner + auto-register

**Files:**
- Create: `agent-host/src/infra/provision.ts`
- Test: `agent-host/test/infra-provision.test.ts`

**Interfaces:**
- Consumes: `AdminExecutor`, `DataSourceEntry` (Task 1).
- Produces:
  - `appendDataSource(path: string, entry: DataSourceEntry): DataSourceEntry[]` — reads the existing `data-sources.json` array (or `[]`), appends, writes, returns the new list. Skips append (returns existing) if an entry with the same `id` exists.
  - `provisionDatabase(deps: { admin: AdminExecutor; dataSourcesPath: string; password: () => string }, name: string): Promise<DataSourceEntry>` — validates `name` as an identifier; derives `db`/`role` = `name`; runs `CREATE ROLE`/`CREATE DATABASE`/`GRANT` via the admin executor; builds a `connectionString` from the admin host/port; appends the source; returns the entry. Throws on an invalid name.

- [ ] **Step 1: Write the failing test** — `agent-host/test/infra-provision.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDataSource, provisionDatabase } from "../src/infra/provision.js";
import type { AdminExecutor } from "../src/infra/types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-prov-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("appendDataSource", () => {
  it("appends to an empty/missing file and dedupes by id", () => {
    const p = join(dir, "ds.json");
    const e = { id: "a", type: "postgres" as const, mode: "read-write" as const, connectionString: "x" };
    expect(appendDataSource(p, e)).toEqual([e]);
    expect(appendDataSource(p, e)).toEqual([e]); // dup id
    const arr = JSON.parse(readFileSync(p, "utf8"));
    expect(arr).toHaveLength(1);
  });

  it("preserves existing entries", () => {
    const p = join(dir, "ds.json");
    writeFileSync(p, JSON.stringify([{ id: "old", type: "postgres", mode: "read", connectionString: "y" }]));
    const out = appendDataSource(p, { id: "new", type: "postgres", mode: "read-write", connectionString: "z" });
    expect(out.map((s) => s.id)).toEqual(["old", "new"]);
  });
});

describe("provisionDatabase", () => {
  const admin: AdminExecutor & { sqls: string[] } = {
    sqls: [],
    async exec(sql: string) { (this as any).sqls.push(sql); },
  };

  beforeEach(() => { admin.sqls = []; });

  it("runs CREATE statements, builds a source, and registers it", async () => {
    const entry = await provisionDatabase(
      { admin, dataSourcesPath: join(dir, "ds.json"), password: () => "pw123" },
      "reports",
    );
    expect(admin.sqls.some((s) => s.includes('CREATE ROLE "reports"'))).toBe(true);
    expect(admin.sqls.some((s) => s.includes('CREATE DATABASE "reports"'))).toBe(true);
    expect(entry).toMatchObject({ id: "reports", type: "postgres", mode: "read-write" });
    expect(entry.connectionString).toContain("reports");
    expect(JSON.parse(readFileSync(join(dir, "ds.json"), "utf8"))).toHaveLength(1);
  });

  it("rejects an invalid database name", async () => {
    await expect(
      provisionDatabase({ admin, dataSourcesPath: join(dir, "ds.json"), password: () => "pw" }, "bad; drop"),
    ).rejects.toThrow(/identifier/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd agent-host && npx vitest run test/infra-provision.test.ts`
Expected: FAIL — cannot resolve `../src/infra/provision.js`.

- [ ] **Step 3: Create `agent-host/src/infra/provision.ts`**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AdminExecutor, DataSourceEntry } from "./types.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function appendDataSource(path: string, entry: DataSourceEntry): DataSourceEntry[] {
  let current: DataSourceEntry[] = [];
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(raw)) current = raw;
    } catch {
      current = [];
    }
  }
  if (current.some((s) => s.id === entry.id)) return current;
  const next = [...current, entry];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2));
  return next;
}

export async function provisionDatabase(
  deps: { admin: AdminExecutor; dataSourcesPath: string; password: () => string; adminConnectionString?: string },
  name: string,
): Promise<DataSourceEntry> {
  if (!IDENT.test(name)) throw new Error(`invalid identifier: ${name}`);
  const pw = deps.password();
  // Parameterizing identifiers isn't supported by Postgres DDL; the IDENT guard
  // above is the safety boundary, and the password is single-quoted (no quotes allowed).
  if (pw.includes("'")) throw new Error("invalid password");
  await deps.admin.exec(`CREATE ROLE "${name}" LOGIN PASSWORD '${pw}'`);
  await deps.admin.exec(`CREATE DATABASE "${name}" OWNER "${name}"`);
  await deps.admin.exec(`GRANT ALL PRIVILEGES ON DATABASE "${name}" TO "${name}"`);

  // Build the new connection string from the admin host/port (default localhost:5432).
  let host = "localhost", port = "5432";
  if (deps.adminConnectionString) {
    try {
      const u = new URL(deps.adminConnectionString);
      host = u.hostname || host;
      port = u.port || port;
    } catch {
      /* keep defaults */
    }
  }
  const entry: DataSourceEntry = {
    id: name,
    type: "postgres",
    mode: "read-write",
    connectionString: `postgres://${name}:${pw}@${host}:${port}/${name}`,
  };
  appendDataSource(deps.dataSourcesPath, entry);
  return entry;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd agent-host && npx vitest run test/infra-provision.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/infra/provision.ts agent-host/test/infra-provision.test.ts
git commit -m "feat(agent-host): database provisioner with data-source auto-register"
```

---

### Task 4: Infra tools + the gating callback

**Files:**
- Create: `agent-host/src/infra/server.ts` (the MCP server + `canUseTool` factory)
- Test: `agent-host/test/infra-server.test.ts`

**Interfaces:**
- Consumes: everything above; `ProxmoxClient`, `AdminExecutor`, `PendingActions`, `appendInfraAudit`, `provisionDatabase`.
- Produces:
  - `GATED_TOOLS: readonly GatedTool[]` and `READ_TOOL_NAMES: readonly string[]` (`["mcp__infra__list_vms", "mcp__infra__vm_status"]`).
  - `createInfraServer(deps: InfraDeps)` → the `createSdkMcpServer` result (the in-process MCP server).
  - `makeCanUseTool(deps: { pending: PendingActions; auditPath: string; now: () => string }): CanUseTool` — gates `mcp__infra__<gated>` tools through the pending queue + audit; passes through (allows) everything else.
  - `interface InfraDeps { proxmox: ProxmoxClient; admin: AdminExecutor; dataSourcesPath: string; auditPath: string; now: () => string; password: () => string; adminConnectionString?: string }`.

The tool handlers are thin wrappers over the seams that return `{ content }` or `{ content, isError:true }`; this task tests the gating callback (the novel logic) directly. The MCP-server construction is build-verified.

- [ ] **Step 1: Write the failing test** — `agent-host/test/infra-server.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCanUseTool, GATED_TOOLS } from "../src/infra/server.js";
import { PendingActions } from "../src/infra/pending.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-gate-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("makeCanUseTool", () => {
  it("passes through (allows) a non-infra tool without enqueuing", async () => {
    const pending = new PendingActions({ now: () => "T", id: () => "a1" });
    const canUse = makeCanUseTool({ pending, auditPath: join(dir, "a.jsonl"), now: () => "T" });
    const r = await canUse("Bash", { command: "ls" }, {} as never);
    expect(r).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(pending.list()).toHaveLength(0);
  });

  it("gates a destructive infra tool: enqueues, awaits, then allows on approve + audits", async () => {
    const pending = new PendingActions({ now: () => "T", id: () => "a1" });
    const auditPath = join(dir, "a.jsonl");
    const canUse = makeCanUseTool({ pending, auditPath, now: () => "T" });

    const promise = canUse("mcp__infra__destroy_vm", { id: 9 }, {} as never);
    // it should be pending now
    expect(pending.list().map((p) => p.tool)).toEqual(["destroy_vm"]);
    pending.resolve("a1", "approve");
    const r = await promise;
    expect(r).toEqual({ behavior: "allow", updatedInput: { id: 9 } });
    expect(JSON.parse(readFileSync(auditPath, "utf8").trim())).toMatchObject({ tool: "mcp__infra__destroy_vm", decision: "approved" });
  });

  it("denies + audits when the operator denies", async () => {
    const pending = new PendingActions({ now: () => "T", id: () => "a1" });
    const auditPath = join(dir, "a.jsonl");
    const canUse = makeCanUseTool({ pending, auditPath, now: () => "T" });
    const promise = canUse("mcp__infra__create_vm", { name: "x" }, {} as never);
    pending.resolve("a1", "deny");
    const r = await promise;
    expect(r.behavior).toBe("deny");
    expect(JSON.parse(readFileSync(auditPath, "utf8").trim()).decision).toBe("denied");
  });

  it("GATED_TOOLS lists the six destructive/provisioning tools", () => {
    expect([...GATED_TOOLS].sort()).toEqual(
      ["create_vm", "destroy_vm", "provision_database", "resize_vm", "start_vm", "stop_vm"],
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd agent-host && npx vitest run test/infra-server.test.ts`
Expected: FAIL — cannot resolve `../src/infra/server.js`.

- [ ] **Step 3: Create `agent-host/src/infra/server.ts`**

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { appendInfraAudit } from "./audit.js";
import { provisionDatabase } from "./provision.js";
import { PendingActions } from "./pending.js";
import type { ProxmoxClient, AdminExecutor, GatedTool } from "./types.js";

export const GATED_TOOLS: readonly GatedTool[] = [
  "create_vm", "start_vm", "stop_vm", "resize_vm", "destroy_vm", "provision_database",
];
export const READ_TOOL_NAMES: readonly string[] = ["mcp__infra__list_vms", "mcp__infra__vm_status"];

type PermissionResult = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };
type CanUseTool = (toolName: string, input: Record<string, unknown>, opts: unknown) => Promise<PermissionResult>;

const GATED_TOOL_NAMES = new Set(GATED_TOOLS.map((t) => `mcp__infra__${t}`));

export function makeCanUseTool(deps: { pending: PendingActions; auditPath: string; now: () => string }): CanUseTool {
  return async (toolName, input) => {
    if (!GATED_TOOL_NAMES.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    const tool = toolName.replace("mcp__infra__", "") as GatedTool;
    const { decision } = deps.pending.enqueue(tool, input);
    const d = await decision;
    appendInfraAudit(deps.auditPath, { ts: deps.now(), tool: toolName, input, decision: d === "approve" ? "approved" : "denied" });
    return d === "approve"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Operator denied this infrastructure action." };
  };
}

export interface InfraDeps {
  proxmox: ProxmoxClient;
  admin: AdminExecutor;
  dataSourcesPath: string;
  auditPath: string;
  now: () => string;
  password: () => string;
  adminConnectionString?: string;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export function createInfraServer(deps: InfraDeps) {
  return createSdkMcpServer({
    name: "infra",
    version: "1.0.0",
    tools: [
      tool("list_vms", "List Proxmox VMs and their status", {}, async () => {
        try { return ok(JSON.stringify(await deps.proxmox.listVms())); } catch (e) { return fail(String(e)); }
      }, { annotations: { readOnlyHint: true } }),
      tool("vm_status", "Get one VM's status", { id: z.number().int() }, async (a) => {
        try { return ok(JSON.stringify(await deps.proxmox.status(a.id))); } catch (e) { return fail(String(e)); }
      }, { annotations: { readOnlyHint: true } }),
      tool("create_vm", "Create a VM", { name: z.string(), cores: z.number().int().default(1), memory: z.number().int().default(1024) }, async (a) => {
        try { return ok(JSON.stringify(await deps.proxmox.create(a))); } catch (e) { return fail(String(e)); }
      }),
      tool("start_vm", "Start a VM", { id: z.number().int() }, async (a) => {
        try { await deps.proxmox.start(a.id); return ok(`started ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
      tool("stop_vm", "Stop a VM", { id: z.number().int() }, async (a) => {
        try { await deps.proxmox.stop(a.id); return ok(`stopped ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
      tool("resize_vm", "Resize a VM's cores/memory", { id: z.number().int(), cores: z.number().int().optional(), memory: z.number().int().optional() }, async (a) => {
        try { await deps.proxmox.resize(a.id, { cores: a.cores, memory: a.memory }); return ok(`resized ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
      tool("destroy_vm", "Destroy a VM", { id: z.number().int() }, async (a) => {
        try { await deps.proxmox.destroy(a.id); return ok(`destroyed ${a.id}`); } catch (e) { return fail(String(e)); }
      }),
      tool("provision_database", "Create a Postgres database and register it as a data source", { name: z.string() }, async (a) => {
        try {
          const entry = await provisionDatabase(
            { admin: deps.admin, dataSourcesPath: deps.dataSourcesPath, password: deps.password, adminConnectionString: deps.adminConnectionString },
            a.name,
          );
          return ok(`provisioned database "${entry.id}" and registered it as a data source`);
        } catch (e) { return fail(String(e)); }
      }),
    ],
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd agent-host && npx vitest run test/infra-server.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (4 tests); `tsc` clean. (If the SDK's `createSdkMcpServer`/`tool` types require a slightly different handler return or annotation shape, adjust the `ok`/`fail` helpers to satisfy them — the gating tests don't exercise the server object, only `makeCanUseTool`.)

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/infra/server.ts agent-host/test/infra-server.test.ts
git commit -m "feat(agent-host): infra MCP tools and the gating canUseTool callback"
```

---

### Task 5: Proxmox client + PG-admin executor (real seams) + `/infra/pending` routes

**Files:**
- Create: `agent-host/src/infra/proxmox.ts`, `agent-host/src/infra/pgAdmin.ts`, `agent-host/src/infra/router.ts`
- Test: `agent-host/test/infra-router.test.ts`

**Interfaces:**
- Produces: `createProxmoxClient(cfg): ProxmoxClient` (real Proxmox VE API; build-verified, live-verified), `createAdminExecutor(connectionString): AdminExecutor` (real `pg`; build-verified), and `createInfraRouter(deps: { pending: PendingActions }): Router` mounted at `/infra` exposing `GET /pending`, `GET /pending/stream`, `POST /pending/:id/resolve`.

- [ ] **Step 1: Write the failing router test** — `agent-host/test/infra-router.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createInfraRouter } from "../src/infra/router.js";
import { PendingActions } from "../src/infra/pending.js";

function app(pending: PendingActions) {
  const a = express();
  a.use(express.json());
  a.use("/infra", createInfraRouter({ pending }));
  return a;
}

describe("infra router", () => {
  it("GET /pending lists pending actions", async () => {
    let n = 0;
    const pending = new PendingActions({ now: () => "T", id: () => `a${++n}` });
    pending.enqueue("destroy_vm", { id: 9 });
    const res = await request(app(pending)).get("/infra/pending");
    expect(res.status).toBe(200);
    expect(res.body.pending).toHaveLength(1);
    expect(res.body.pending[0].tool).toBe("destroy_vm");
  });

  it("POST /pending/:id/resolve resolves a pending action", async () => {
    let n = 0;
    const pending = new PendingActions({ now: () => "T", id: () => `a${++n}` });
    const { decision } = pending.enqueue("create_vm", { name: "x" });
    const res = await request(app(pending)).post("/infra/pending/a1/resolve").send({ decision: "approve" });
    expect(res.status).toBe(200);
    expect(await decision).toBe("approve");
  });

  it("rejects a bad decision and an unknown id", async () => {
    const pending = new PendingActions({ now: () => "T", id: () => "a1" });
    expect((await request(app(pending)).post("/infra/pending/a1/resolve").send({ decision: "maybe" })).status).toBe(400);
    expect((await request(app(pending)).post("/infra/pending/missing/resolve").send({ decision: "approve" })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd agent-host && npx vitest run test/infra-router.test.ts`
Expected: FAIL — cannot resolve `../src/infra/router.js`.

- [ ] **Step 3: Create `agent-host/src/infra/router.ts`**

```typescript
import express, { type Router, type Request, type Response } from "express";
import type { PendingActions } from "./pending.js";

export function createInfraRouter(deps: { pending: PendingActions }): Router {
  const router = express.Router();

  router.get("/pending", (_req, res) => {
    res.json({ pending: deps.pending.list() });
  });

  router.get("/pending/stream", (req: Request, res: Response) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders?.();
    for (const a of deps.pending.list()) res.write(`data: ${JSON.stringify({ type: "added", action: a })}\n\n`);
    const unsub = deps.pending.subscribe((kind, action) => res.write(`data: ${JSON.stringify({ type: kind, action })}\n\n`));
    req.on("close", unsub);
  });

  router.post("/pending/:id/resolve", (req: Request, res: Response) => {
    const { decision } = req.body ?? {};
    if (decision !== "approve" && decision !== "deny") return void res.status(400).json({ error: "bad decision" });
    const ok = deps.pending.resolve(req.params.id, decision);
    if (!ok) return void res.sendStatus(404);
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Run the router test**

Run: `cd agent-host && npx vitest run test/infra-router.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create the real seams** — `agent-host/src/infra/proxmox.ts`

```typescript
import type { ProxmoxClient, InfraConfig, Vm, VmStatus } from "./types.js";

// Real Proxmox VE API client. Auth via API token header. Endpoint paths follow the
// Proxmox VE API (qemu under /nodes/{node}/qemu). Live-verified against the operator's PVE.
export function createProxmoxClient(cfg: NonNullable<InfraConfig["proxmox"]>): ProxmoxClient {
  const base = `${cfg.baseUrl.replace(/\/$/, "")}/api2/json`;
  const headers = { Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`, "Content-Type": "application/x-www-form-urlencoded" };
  const node = cfg.node;

  async function call(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? new URLSearchParams(body as Record<string, string>).toString() : undefined,
    });
    if (!res.ok) throw new Error(`proxmox ${method} ${path}: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { data: unknown }).data;
  }

  return {
    async listVms(): Promise<Vm[]> {
      const data = (await call("GET", `/nodes/${node}/qemu`)) as Array<{ vmid: number; name?: string; status: string }>;
      return data.map((v) => ({ id: v.vmid, name: v.name ?? String(v.vmid), status: v.status }));
    },
    async status(id: number): Promise<VmStatus> {
      const d = (await call("GET", `/nodes/${node}/qemu/${id}/status/current`)) as { status: string; cpus?: number; maxmem?: number };
      return { id, status: d.status, cpus: d.cpus, maxmem: d.maxmem };
    },
    async create(spec): Promise<{ id: number }> {
      // Allocate the next id, then create. Operators may prefer cloning a template;
      // adjust to your PVE setup during the live run.
      const next = (await call("GET", "/cluster/nextid")) as number;
      await call("POST", `/nodes/${node}/qemu`, { vmid: next, name: spec.name, cores: spec.cores, memory: spec.memory });
      return { id: Number(next) };
    },
    async start(id) { await call("POST", `/nodes/${node}/qemu/${id}/status/start`); },
    async stop(id) { await call("POST", `/nodes/${node}/qemu/${id}/status/stop`); },
    async resize(id, spec) { await call("POST", `/nodes/${node}/qemu/${id}/config`, { ...(spec.cores ? { cores: spec.cores } : {}), ...(spec.memory ? { memory: spec.memory } : {}) }); },
    async destroy(id) { await call("DELETE", `/nodes/${node}/qemu/${id}`); },
  };
}
```

- [ ] **Step 6: Create `agent-host/src/infra/pgAdmin.ts`**

```typescript
import pg from "pg";
import type { AdminExecutor } from "./types.js";

export function createAdminExecutor(connectionString: string): AdminExecutor {
  const pool = new pg.Pool({ connectionString });
  return {
    async exec(sql: string) {
      await pool.query(sql);
    },
  };
}
```

Add `pg` + `@types/pg` to `agent-host/package.json` (deps/devDeps) and `npm install`. (`zod` and `@anthropic-ai/claude-agent-sdk` are already present — the SDK depends on zod.)

- [ ] **Step 7: Build + the infra suite**

Run: `cd agent-host && npm install && npx vitest run test/infra-*.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: all infra tests PASS; `tsc` clean.

- [ ] **Step 8: Commit**

```bash
git add agent-host/src/infra/proxmox.ts agent-host/src/infra/pgAdmin.ts agent-host/src/infra/router.ts agent-host/test/infra-router.test.ts agent-host/package.json agent-host/package-lock.json
git commit -m "feat(agent-host): real Proxmox/PG-admin seams and /infra/pending routes"
```

---

### Task 6: Wire the infra capability into the agent host

**Files:**
- Modify: `agent-host/src/sessionManager.ts` (accept extra query options), `agent-host/src/index.ts` (build the infra layer, mount the router, wire the SDK options)
- Test: extend `agent-host/test/index.smoke.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: the agent host, when `proxmox` + `pgAdmin` config are present, registers the `infra` MCP server, allowlists the read tools, and gates the rest via `canUseTool`; `GET /infra/pending` is mounted.

- [ ] **Step 1: Thread extra SDK options through `SessionManager`**

In `agent-host/src/sessionManager.ts`, the manager builds the `options` object for `query`. Add an optional `extraOptions` to the constructor that is merged into every `query` options object (so `mcpServers`, `allowedTools`, `canUseTool` flow through without the manager knowing their shapes). Change the constructor opts to accept `extraOptions?: Record<string, unknown>` and spread it into `options`:

```typescript
// in the constructor opts type add: extraOptions?: Record<string, unknown>;
// store this.extraOptions = opts.extraOptions ?? {};
// in run(), after building `options`:
    const merged = { ...options, ...this.extraOptions };
    // ...use `merged` in this.query({ prompt, options: merged })
```

Update the existing SessionManager tests' constructor calls only if they break (they don't pass extraOptions, so the default `{}` keeps them green).

- [ ] **Step 2: Build the infra layer in `agent-host/src/index.ts`**

When `config.proxmox` and `config.pgAdmin` are present (use `loadInfraConfig(process.env)`), construct the layer and pass the SDK options + mount the router. Add (guard the whole thing so the host still runs without infra config):

```typescript
import express from "express";
import { loadInfraConfig } from "./infra/config.js";
import { createProxmoxClient } from "./infra/proxmox.js";
import { createAdminExecutor } from "./infra/pgAdmin.js";
import { PendingActions } from "./infra/pending.js";
import { createInfraServer, makeCanUseTool, READ_TOOL_NAMES } from "./infra/server.js";
import { createInfraRouter } from "./infra/router.js";

// inside buildApp/main wiring, after the Express app + agent host exist:
function wireInfra(app: import("express").Express, sessionExtraOptions: Record<string, unknown>): void {
  const infra = loadInfraConfig(process.env);
  if (!infra.proxmox || !infra.pgAdmin) return; // infra optional
  const now = () => new Date().toISOString();
  const pending = new PendingActions({ now, id: () => crypto.randomUUID() });
  const server = createInfraServer({
    proxmox: createProxmoxClient(infra.proxmox),
    admin: createAdminExecutor(infra.pgAdmin.connectionString),
    dataSourcesPath: infra.dataSourcesPath,
    auditPath: infra.auditPath,
    now,
    password: () => crypto.randomUUID().replace(/-/g, ""),
    adminConnectionString: infra.pgAdmin.connectionString,
  });
  sessionExtraOptions.mcpServers = { infra: server };
  sessionExtraOptions.allowedTools = [...READ_TOOL_NAMES];
  sessionExtraOptions.canUseTool = makeCanUseTool({ pending, auditPath: infra.auditPath, now });
  app.use(express.json());
  app.use("/infra", createInfraRouter({ pending }));
}
```

Wire it: create a `sessionExtraOptions = {}` object, call `wireInfra(app, sessionExtraOptions)` after the app exists, and pass `extraOptions: sessionExtraOptions` into the `SessionManager` you construct. (The infra MCP server must be created **before** the SessionManager so the options are populated.)

- [ ] **Step 3: Extend the smoke test** — add a case to `agent-host/test/index.smoke.test.ts` proving the host still boots without infra config (the common path) by asserting `buildApp` returns an app whose `/healthz` works (already covered) and that `/infra/pending` is **404** when no infra config is set (infra not wired):

```typescript
  it("does not mount /infra without proxmox+pg-admin config", async () => {
    const app = buildApp({ config: { port: 0, workspace: "./workspace" } as never, query: () => (async function* () { yield { type: "result", result: "", is_error: false }; })() });
    const res = await request(app).get("/infra/pending");
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 4: Full agent-host suite + typecheck**

Run: `cd agent-host && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/sessionManager.ts agent-host/src/index.ts agent-host/test/index.smoke.test.ts
git commit -m "feat(agent-host): wire infra MCP server, gating, and /infra routes"
```

---

### Task 7: Dashboard host — re-read data sources per request

**Files:**
- Modify: `dashboard-host/src/index.ts` (build `sources`/`getExecutor` to re-read the file)
- Test: `dashboard-host/test/index.smoke.test.ts` (a source added after startup is found)

**Interfaces:**
- Produces: the `/data` layer reads `data-sources.json` fresh on each request, so an agent-provisioned source appears without restart.

- [ ] **Step 1: Write the failing test** — add to `dashboard-host/test/index.smoke.test.ts`:

```typescript
  it("picks up a data source added to data-sources.json after startup", async () => {
    const dsPath = join(workspace, "data-sources.json");
    writeFileSync(dsPath, JSON.stringify([])); // start empty
    const app = buildApp({
      config: { port: 0, workspace, dataSourcesPath: dsPath, dataTrustPath: join(workspace, "t.json"), dataAuditPath: join(workspace, "a.jsonl") } as never,
      watch: () => ({ close() {} }),
      executorFor: () => ({ async run() { return { rows: [{ ok: 1 }], rowCount: 1 }; } }),
    });
    // not present yet → 404
    expect((await request(app).post("/data/late/query").send({ op: { kind: "select", table: "t" } })).status).toBe(404);
    // add it
    writeFileSync(dsPath, JSON.stringify([{ id: "late", type: "postgres", mode: "read-write", connectionString: "x" }]));
    // now found
    expect((await request(app).post("/data/late/query").send({ op: { kind: "select", table: "t" } })).status).toBe(200);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard-host && npx vitest run test/index.smoke.test.ts`
Expected: FAIL — sources are loaded once, so `late` stays 404.

- [ ] **Step 3: Re-read sources per request** in `dashboard-host/src/index.ts`. Replace the one-time `const sources = loadDataSources(...)` + `getExecutor` with a fresh read each request. The `createDataRouter` deps take `sources` directly; change `buildApp` to pass a getter that re-reads, by making the router resolve sources per call. Minimal approach: wrap the data wiring so `sources` is recomputed. Change the data layer construction to:

```typescript
  const executorCache = new Map<string, QueryExecutor>();
  const getExecutor = (sourceId: string): QueryExecutor => {
    let ex = executorCache.get(sourceId);
    if (!ex) {
      const src = loadDataSources(deps.config.dataSourcesPath).find((s) => s.id === sourceId);
      if (!src) throw new Error(`unknown source: ${sourceId}`);
      ex = executorFor(src);
      executorCache.set(sourceId, ex);
    }
    return ex;
  };
  // Pass a live sources getter to the router instead of a static array.
  app.use("/data", createDataRouter({
    getSources: () => loadDataSources(deps.config.dataSourcesPath),
    getExecutor, queue, trustPath: deps.config.dataTrustPath, auditPath: deps.config.dataAuditPath, now,
  }));
```

And in `dashboard-host/src/data/router.ts`, change `DataRouterDeps` from `sources: DataSource[]` to `getSources: () => DataSource[]`, and replace each `findSource(deps.sources, req.params.source)` with `findSource(deps.getSources(), req.params.source)`. Update `dashboard-host/test/data-router.test.ts`'s `createDataRouter({...})` call from `sources` to `getSources: () => sources`.

- [ ] **Step 4: Full dashboard-host suite + typecheck**

Run: `cd dashboard-host && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS (incl. the new late-source test); `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src/index.ts dashboard-host/src/data/router.ts dashboard-host/test/data-router.test.ts dashboard-host/test/index.smoke.test.ts
git commit -m "feat(dashboard-host): re-read data sources per request for auto-registration"
```

---

### Task 8: Client — infra-pending IPC + generalized confirmation

**Files:**
- Modify: `client/src-tauri/src/proxy.rs` (add an `infra` slot + commands), `client/src-tauri/src/lib.rs` (register), `client/src/lib/tauri.ts` (wrappers)
- Modify: `client/src/lib/pendingStore.ts` (carry an `origin` discriminator), `client/src/components/ConfirmationDialog.tsx` (handle both origins), `client/src/App.tsx` (open both streams)
- Test: `client/test/pendingStore.test.ts` (extend), `client/test/ConfirmationDialog.test.tsx` (extend)

**Interfaces:**
- Produces (Rust): `start_infra_pending_stream`, `stop_infra_pending_stream`, `resolve_infra_pending` (point at the agent base, mirror the data-pending commands).
- Produces (TS): `openInfraPendingStream(agentBase, onPending)`, `resolveInfraPending(agentBase, pendingId, decision)`.
- Produces: `PendingItem` gains `origin: "data" | "infra"`; the dialog routes Approve/Deny + (data-only) trust to the right resolve.

- [ ] **Step 1: Rust — add an `infra` slot + commands** in `proxy.rs`:

Add `pub infra: Mutex<Option<CancellationToken>>` to `StreamState`. Add (mirroring the pending data commands):

```rust
#[tauri::command]
pub async fn start_infra_pending_stream(
    state: tauri::State<'_, StreamState>,
    agent_base: String,
    on_pending: Channel<Value>,
) -> Result<(), String> {
    let token = CancellationToken::new();
    if let Some(old) = state.infra.lock().unwrap().replace(token.clone()) { old.cancel(); }
    let url = format!("{}/infra/pending/stream", agent_base.trim_end_matches('/'));
    tokio::spawn(async move { pump(url, on_pending, token).await });
    Ok(())
}

#[tauri::command]
pub fn stop_infra_pending_stream(state: tauri::State<'_, StreamState>) {
    if let Some(tok) = state.infra.lock().unwrap().take() { tok.cancel(); }
}

#[tauri::command]
pub async fn resolve_infra_pending(agent_base: String, pending_id: String, decision: String) -> Result<(), String> {
    let url = format!("{}/infra/pending/{}/resolve", agent_base.trim_end_matches('/'), pending_id);
    reqwest::Client::new().post(&url).json(&serde_json::json!({ "decision": decision })).send().await.map(|_| ()).map_err(|e| e.to_string())
}
```

Register the three in `lib.rs`'s `generate_handler![...]`.

- [ ] **Step 2: TS wrappers** in `client/src/lib/tauri.ts`:

```typescript
export function openInfraPendingStream(agentBase: string, onPending: (e: unknown) => void): () => void {
  const channel = new Channel<unknown>();
  channel.onmessage = onPending;
  void invoke("start_infra_pending_stream", { agentBase, onPending: channel });
  return () => void invoke("stop_infra_pending_stream");
}

export function resolveInfraPending(agentBase: string, pendingId: string, decision: "approve" | "deny"): Promise<void> {
  return invoke("resolve_infra_pending", { agentBase, pendingId, decision });
}
```

- [ ] **Step 3: Extend `pendingStore` with an `origin`** — write the failing test additions in `client/test/pendingStore.test.ts`:

```typescript
  it("tags items with their origin and keeps data + infra items distinct", () => {
    const data = { type: "added", write: { pendingId: "p1", source: "ops", op: {}, surfaceId: "d1" } };
    const infra = { type: "added", action: { pendingId: "a1", tool: "destroy_vm", input: { id: 9 } } };
    let list = reducePending([], data, "data");
    list = reducePending(list, infra, "infra");
    expect(list.map((x) => [x.origin, x.pendingId])).toEqual([["data", "p1"], ["infra", "a1"]]);
  });
```

Then update `client/src/lib/pendingStore.ts` to add `origin` and accept it, and read the item from either `write` (data) or `action` (infra):

```typescript
export interface PendingItem {
  origin: "data" | "infra";
  pendingId: string;
  source?: string;        // data
  op?: unknown;           // data op or infra input
  surfaceId?: string | null; // data
  tool?: string;          // infra
}

export function reducePending(list: PendingItem[], event: unknown, origin: "data" | "infra"): PendingItem[] {
  if (typeof event !== "object" || event === null) return list;
  const e = event as { type?: string; write?: Record<string, unknown>; action?: Record<string, unknown> };
  const raw = e.write ?? e.action;
  if (!raw || typeof raw.pendingId !== "string") return list;
  if (e.type === "added") {
    if (list.some((x) => x.pendingId === raw.pendingId)) return list;
    const item: PendingItem =
      origin === "data"
        ? { origin, pendingId: raw.pendingId as string, source: raw.source as string, op: raw.op, surfaceId: (raw.surfaceId ?? null) as string | null }
        : { origin, pendingId: raw.pendingId as string, tool: raw.tool as string, op: raw.input };
    return [...list, item];
  }
  if (e.type === "resolved") return list.filter((x) => x.pendingId !== raw.pendingId);
  return list;
}
```

Update the existing `pendingStore.test.ts` calls to pass `"data"` as the third arg (the existing tests used the two-arg form). Run `cd client && npx vitest run test/pendingStore.test.ts` → green.

- [ ] **Step 4: Generalize `ConfirmationDialog`** to subscribe to both streams and route resolves by origin. Update `client/src/components/ConfirmationDialog.tsx`:

```tsx
import { useEffect, useState } from "react";
import { reducePending, type PendingItem } from "../lib/pendingStore";
import { openPendingStream, resolvePending, openInfraPendingStream, resolveInfraPending } from "../lib/tauri";

export function ConfirmationDialog({ agentBase, dashboardBase }: { agentBase: string; dashboardBase: string }) {
  const [queue, setQueue] = useState<PendingItem[]>([]);
  const [trust, setTrust] = useState(false);

  useEffect(() => {
    const stopData = openPendingStream(dashboardBase, (e) => setQueue((p) => reducePending(p, e, "data")));
    const stopInfra = openInfraPendingStream(agentBase, (e) => setQueue((p) => reducePending(p, e, "infra")));
    return () => { stopData(); stopInfra(); };
  }, [agentBase, dashboardBase]);

  const current = queue[0];
  if (!current) return null;

  async function decide(decision: "approve" | "deny") {
    if (current.origin === "data") {
      await resolvePending(dashboardBase, current.pendingId, decision, decision === "approve" && trust);
    } else {
      await resolveInfraPending(agentBase, current.pendingId, decision);
    }
    setQueue((p) => p.filter((x) => x.pendingId !== current.pendingId));
    setTrust(false);
  }

  return (
    <div role="dialog" aria-label="Confirm action" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", color: "#111", padding: 20, borderRadius: 8, maxWidth: 480 }}>
        <h2>{current.origin === "data" ? `Write to “${current.source}”` : `Infrastructure: ${current.tool}`}</h2>
        {current.origin === "data" && <p>Surface: {current.surfaceId ?? "unknown"}</p>}
        <pre style={{ background: "#f3f4f6", padding: 8, overflow: "auto" }}>{JSON.stringify(current.op, null, 2)}</pre>
        {current.origin === "data" && (
          <label><input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} /> Trust this surface</label>
        )}
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button onClick={() => decide("approve")}>Approve</button>
          <button onClick={() => decide("deny")}>Deny</button>
        </div>
      </div>
    </div>
  );
}
```

Update `client/src/App.tsx` to pass `agentBase` to the dialog: `<ConfirmationDialog agentBase={config.agentBase} dashboardBase={config.dashboardBase} />`.

- [ ] **Step 5: Extend the dialog test** — in `client/test/ConfirmationDialog.test.tsx`, mock the infra wrappers too and add a test that an infra `added` event renders the tool name and Approve calls `resolveInfraPending`:

```tsx
  it("confirms an infra action via resolveInfraPending", async () => {
    // extend the vi.mock("../src/lib/tauri", ...) factory to also export
    // openInfraPendingStream: vi.fn((_b, on) => { capturedInfra = on; return () => {}; }),
    // resolveInfraPending: (...a) => infraResolveSpy(...a),
    render(<ConfirmationDialog agentBase="http://a:8787" dashboardBase="http://d:8788" />);
    capturedInfra?.({ type: "added", action: { pendingId: "a1", tool: "destroy_vm", input: { id: 9 } } });
    await screen.findByText(/destroy_vm/);
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(infraResolveSpy).toHaveBeenCalledWith("http://a:8787", "a1", "approve");
  });
```

(Update the existing dialog tests to pass both `agentBase` and `dashboardBase` props, and extend the `vi.mock` factory with the infra exports + `capturedInfra`/`infraResolveSpy` module-scope vars.)

- [ ] **Step 6: Build + full client suite + typecheck + cargo build**

Run: `cd client && npx vitest run && npx tsc -p tsconfig.json --noEmit && cd src-tauri && cargo build`
Expected: all PASS; `tsc` clean; `cargo build` clean.

- [ ] **Step 7: Commit**

```bash
git add client/src-tauri/src/proxy.rs client/src-tauri/src/lib.rs client/src/lib/tauri.ts client/src/lib/pendingStore.ts client/src/components/ConfirmationDialog.tsx client/src/App.tsx client/test/pendingStore.test.ts client/test/ConfirmationDialog.test.tsx
git commit -m "feat(client): infra-pending IPC and generalized confirmation dialog"
```

---

## Done criteria (automated)

- `cd agent-host && npx vitest run && npx tsc -p tsconfig.json --noEmit` — pass (infra config/pending/provision/gating/router + wiring; nothing else broken).
- `cd dashboard-host && npx vitest run && npx tsc -p tsconfig.json --noEmit` — pass (per-request source read).
- `cd client && npx vitest run && npx tsc -p tsconfig.json --noEmit && cd src-tauri && cargo build` — pass.

## Live verification (driver-run, against your Proxmox)

Set on the agent host: `RHUMBR_PROXMOX_URL`, `RHUMBR_PROXMOX_TOKEN_ID`, `RHUMBR_PROXMOX_TOKEN_SECRET`, `RHUMBR_PROXMOX_NODE` (a scoped PVE token), and `RHUMBR_PG_ADMIN` (a Postgres admin connection on the Proxmox box).
1. Ask the agent to "provision a database called demo and build a dashboard that lists its rows." → the confirmation dialog pops for `provision_database` → approve → the DB exists, a `data-sources.json` entry appears, the dashboard host serves it, and the surface reads it (this also completes Plan 4's live verification).
2. Ask the agent to "create a small VM, then destroy it." → each gated op pops a confirmation → approve → the VM appears/disappears in Proxmox; check `infra-audit.jsonl`. Deny a destroy → the VM stays.
3. Confirm `list_vms`/`vm_status` run without a confirmation dialog (allowlisted).

## Next plan

**Plan 6 — Spawned services:** container-isolated agent-spawned full backend services (reusing this plan's gating + the Proxmox client for the containers), registered through the dashboard host's reverse proxy and rendered like file surfaces.
