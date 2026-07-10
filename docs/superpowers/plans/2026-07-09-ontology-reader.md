# Ontology Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the ontology real consumers — `GET /ontology` (sync-on-read, visible sync errors) on agent-host, prompt wiring for the agent, and a client System-map sidebar replacing the flat surfaces list.

**Architecture:** agent-host's existing `OntologyOps` gains `list()`/`status()`; a tiny Express router mounts at `/ontology` behind the existing app-level identity guards (same pattern as `/infra`). The Tauri client adds one Rust proxy command and swaps `SurfacesPanel` for an `OntologyPanel` fed by pure helpers in `lib/ontologyStore.ts`.

**Tech Stack:** TypeScript + Express + vitest (agent-host); Rust/Tauri v2 + React + vitest/@testing-library (client).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-ontology-reader-design.md`.
- All agent-host imports use `.js` suffixes (ESM); tests import from `../src/....js`.
- No new dependencies anywhere.
- Section order is fixed: Dashboards, Services, Containers, Data sources, VMs, Domain; empty sections omitted; unknown node types fold into Domain.
- Sync failures must never 500 the endpoint or fail an infra op — degrade to last-good nodes with `syncError` set.
- Rail section id stays `"surfaces"`; visible label becomes "System map".

---

### Task 1: `OntologyOps.list()` and `status()` with sync outcome recording

**Files:**
- Modify: `agent-host/src/ontology/ops.ts`
- Test: `agent-host/test/ontology-ops.test.ts` (append)

**Interfaces:**
- Produces: `OntologyOps.list(): OntologyNode[]`; `OntologyOps.status(): { syncedAt: string | null; syncError: string | null }`; `sync()` records success time / failure message (and still rethrows on failure).

- [ ] **Step 1: Write the failing tests** — append to `agent-host/test/ontology-ops.test.ts` (reuse the existing `dir`/`writeNode` harness at the top of the file):

```ts
describe("ontology ops read side", () => {
  it("list() returns system and domain nodes merged", () => {
    const o = ops();
    writeNode(join(dir, "system"), { type: "service", id: "service-x", title: "X", managed: "system", props: {}, relationships: [] });
    o.upsert({ id: "customer-1", title: "Acme" });
    expect(o.list().map((n) => n.id).sort()).toEqual(["customer-1", "service-x"]);
  });

  it("status() starts empty, records a successful sync, and records a failure", () => {
    const systemDir = join(dir, "system");
    const domainDir = join(dir, "domain");
    let fail = false;
    const o = createOntologyOps({
      systemDir, domainDir, now: () => "T1",
      sync: () => { if (fail) throw new Error("boom"); return { added: 0, updated: 0, removed: 0 }; },
    });
    expect(o.status()).toEqual({ syncedAt: null, syncError: null });
    o.sync();
    expect(o.status()).toEqual({ syncedAt: "T1", syncError: null });
    fail = true;
    expect(() => o.sync()).toThrow("boom");
    expect(o.status()).toEqual({ syncedAt: "T1", syncError: "boom" });
    fail = false;
    o.sync();
    expect(o.status().syncError).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/ontology-ops.test.ts`
Expected: FAIL — `o.list is not a function` / `o.status is not a function`.

- [ ] **Step 3: Implement** in `agent-host/src/ontology/ops.ts`. Extend the interface:

```ts
export interface OntologyOps {
  sync(): { added: number; updated: number; removed: number };
  list(): OntologyNode[];
  status(): { syncedAt: string | null; syncError: string | null };
  query(q: OntologyQuery): unknown;
  upsert(node: { id: string; title: string; subtype?: string; props?: Record<string, string> }): OntologyNode;
  link(from: string, edge: string, to: string): OntologyNode;
}
```

Inside `createOntologyOps`, before the `return`:

```ts
  let syncedAt: string | null = null;
  let syncError: string | null = null;
```

Replace `sync: deps.sync,` in the returned object with:

```ts
    sync() {
      try {
        const r = deps.sync();
        syncedAt = deps.now();
        syncError = null;
        return r;
      } catch (e) {
        syncError = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },
    list: allNodes,
    status: () => ({ syncedAt, syncError }),
```

- [ ] **Step 4: Run to verify pass**

Run: `cd agent-host && npx vitest run test/ontology-ops.test.ts`
Expected: PASS (all, including pre-existing tests — `sync()` behavior for callers is unchanged: same return, same throw).

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/ontology/ops.ts agent-host/test/ontology-ops.test.ts
git commit -m "feat(agent-host): ontology ops list()/status() with sync outcome recording"
```

---

### Task 2: `GET /ontology` router — sync-on-read, degrade on failure

**Files:**
- Create: `agent-host/src/ontology/router.ts`
- Test: `agent-host/test/ontology-router.test.ts`

**Interfaces:**
- Consumes: `OntologyOps` from Task 1 (`sync`, `list`, `status`).
- Produces: `createOntologyRouter(deps: { ops: OntologyOps }): Router` serving `GET /` → `{ nodes, syncedAt, syncError }`.

- [ ] **Step 1: Write the failing test** — create `agent-host/test/ontology-router.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createOntologyRouter } from "../src/ontology/router.js";
import type { OntologyOps } from "../src/ontology/ops.js";

function app(ops: OntologyOps) {
  const a = express();
  a.use("/ontology", createOntologyRouter({ ops }));
  return a;
}

const node = { type: "service", id: "service-x", title: "X", managed: "system" as const, props: {}, relationships: [] };

describe("GET /ontology", () => {
  it("syncs on read and returns nodes with sync status", async () => {
    const sync = vi.fn(() => ({ added: 0, updated: 1, removed: 0 }));
    const ops = {
      sync, list: () => [node], status: () => ({ syncedAt: "T1", syncError: null }),
      query: () => null, upsert: () => node, link: () => node,
    } as unknown as OntologyOps;
    const res = await request(app(ops)).get("/ontology");
    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledOnce();
    expect(res.body).toEqual({ nodes: [node], syncedAt: "T1", syncError: null });
  });

  it("degrades to last-good nodes when sync throws", async () => {
    const ops = {
      sync: () => { throw new Error("projector broke"); },
      list: () => [node], status: () => ({ syncedAt: "T0", syncError: "projector broke" }),
      query: () => null, upsert: () => node, link: () => node,
    } as unknown as OntologyOps;
    const res = await request(app(ops)).get("/ontology");
    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.syncError).toBe("projector broke");
    expect(res.body.syncedAt).toBe("T0");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/ontology-router.test.ts`
Expected: FAIL — cannot resolve `../src/ontology/router.js`.

- [ ] **Step 3: Implement** — create `agent-host/src/ontology/router.ts`:

```ts
import express, { type Router } from "express";
import type { OntologyOps } from "./ops.js";

export function createOntologyRouter(deps: { ops: OntologyOps }): Router {
  const router = express.Router();

  router.get("/", (_req, res) => {
    // Sync-on-read: a reader must never see a projection older than its own
    // request (dogfood F16). A failing projector degrades to the last-good
    // nodes on disk with the error visible in status — never a 500.
    try { deps.ops.sync(); } catch { /* outcome recorded by ops.status() */ }
    const { syncedAt, syncError } = deps.ops.status();
    res.json({ nodes: deps.ops.list(), syncedAt, syncError });
  });

  return router;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd agent-host && npx vitest run test/ontology-router.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/ontology/router.ts agent-host/test/ontology-router.test.ts
git commit -m "feat(agent-host): GET /ontology router with sync-on-read and error degradation"
```

---

### Task 3: Mount `/ontology` in the app + smoke coverage

**Files:**
- Modify: `agent-host/src/index.ts` (import + mount next to the `/infra` mount)
- Test: `agent-host/test/index.smoke.test.ts` (append)

**Interfaces:**
- Consumes: `createOntologyRouter` (Task 2), existing `ontologyOps` local in `buildApp`.
- Produces: `/ontology` route on the built app, behind the same app-level identity/shell guards as every route (mounting on the `createServer` app inherits them, exactly like `/infra`).

- [ ] **Step 1: Write the failing test** — append to the existing describe in `agent-host/test/index.smoke.test.ts`, following that file's existing `buildApp` fixture conventions (it already boots the app with the ontology wired — see its "boots with the ontology wired" test):

```ts
  it("serves GET /ontology with nodes and sync status", async () => {
    const app = mkApp(); // the file's existing app-builder helper — reuse verbatim
    const res = await request(app).get("/ontology");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(res.body).toHaveProperty("syncedAt");
    expect(res.body).toHaveProperty("syncError");
  });
```

(Adapt the helper name to whatever the smoke file actually calls its app fixture — read the file first; it builds via `buildApp` with dev-mode identity config.)

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/index.smoke.test.ts`
Expected: FAIL — 404 on `/ontology`.

- [ ] **Step 3: Implement** in `agent-host/src/index.ts`: add to the imports

```ts
import { createOntologyRouter } from "./ontology/router.js";
```

and directly after the `if (infraPending) { app.use("/infra", ...) }` block:

```ts
  app.use("/ontology", createOntologyRouter({ ops: ontologyOps }));
```

Leave the `onMutate` hook exactly as is — its `catch` must keep infra ops alive, and the failure is now recorded inside `ops.sync()` (Task 1), so it is no longer silent.

- [ ] **Step 4: Run to verify pass**

Run: `cd agent-host && npx vitest run test/index.smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/index.ts agent-host/test/index.smoke.test.ts
git commit -m "feat(agent-host): mount identity-gated /ontology endpoint"
```

---

### Task 4: Prompt wiring — tell the agent the ontology exists

**Files:**
- Modify: `agent-host/src/prompt.ts`
- Test: `agent-host/test/prompt.test.ts` (create; no prompt test exists today)

**Interfaces:**
- Produces: `RHUMB_PROMPT_APPEND` mentions the ontology tools.

- [ ] **Step 1: Write the failing test** — create `agent-host/test/prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RHUMB_PROMPT_APPEND } from "../src/prompt.js";

describe("RHUMB_PROMPT_APPEND", () => {
  it("tells the agent the ontology tools exist and how the layers split", () => {
    expect(RHUMB_PROMPT_APPEND).toMatch(/mcp__ontology__query/);
    expect(RHUMB_PROMPT_APPEND).toMatch(/upsert_node/);
    expect(RHUMB_PROMPT_APPEND).toMatch(/system layer/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/prompt.test.ts`
Expected: FAIL — no ontology mention.

- [ ] **Step 3: Implement** — append two entries to the `RHUMB_PROMPT_APPEND` array in `agent-host/src/prompt.ts` (before the closing `].join`):

```ts
  "The workspace keeps a persistent ontology: a markdown graph of everything on the box (services, containers, data sources, dashboards, VMs, plus domain entities you author).",
  "Use mcp__ontology__query to orient before infra work; record durable domain knowledge with mcp__ontology__upsert_node and mcp__ontology__link. The system layer is regenerated from live state on every sync — author only the domain layer.",
```

- [ ] **Step 4: Run to verify pass**

Run: `cd agent-host && npx vitest run test/prompt.test.ts`
Expected: PASS. Also run the full package: `npx vitest run` — expected all green.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/prompt.ts agent-host/test/prompt.test.ts
git commit -m "feat(agent-host): document ontology tools in the session prompt"
```

---

### Task 5: Rust proxy command `get_ontology`

**Files:**
- Modify: `client/src-tauri/src/proxy.rs` (add command after `list_sessions`, ~line 460)
- Modify: `client/src-tauri/src/lib.rs` (register in `generate_handler!` after `proxy::stop_agent_stream`)

**Interfaces:**
- Consumes: existing `agent_target` + `shell_request` helpers in `proxy.rs`.
- Produces: Tauri command `get_ontology(agent_base: String) -> Result<Value, String>` (invoked from TS as `invoke("get_ontology", { agentBase })`).

- [ ] **Step 1: Implement** (Rust side has no HTTP-level test harness — every command is covered by the tested `agent_target` pinning; follow `list_sessions` verbatim). In `proxy.rs`:

```rust
#[tauri::command]
pub async fn get_ontology(app: tauri::AppHandle, agent_base: String) -> Result<Value, String> {
    let (url, bearer) = agent_target(&app, &agent_base, "/ontology")?;
    let client = reqwest::Client::new();
    let req = shell_request(client.get(&url), &bearer);
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}
```

In `lib.rs`, inside `generate_handler![`:

```rust
            proxy::get_ontology,
```

- [ ] **Step 2: Verify compile + existing tests**

Run: `cd client/src-tauri && cargo test --quiet`
Expected: builds; 20 pre-existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add client/src-tauri/src/proxy.rs client/src-tauri/src/lib.rs
git commit -m "feat(client): get_ontology proxy command"
```

---

### Task 6: Client types, `getOntology` binding, and pure `ontologyStore` helpers

**Files:**
- Modify: `client/src/lib/types.ts` (append the mirrored contract types)
- Modify: `client/src/lib/tauri.ts` (add binding)
- Create: `client/src/lib/ontologyStore.ts`
- Test: `client/test/ontologyStore.test.ts`

**Interfaces:**
- Produces:
  - `OntologyNode { type: string; id: string; title: string; managed: "system" | "domain"; props: Record<string, string>; relationships: { edge: string; target: string }[] }` and `OntologySnapshot { nodes: OntologyNode[]; syncedAt: string | null; syncError: string | null }` in `types.ts`.
  - `getOntology(agentBase: string): Promise<OntologySnapshot>` in `tauri.ts`.
  - `groupNodes(nodes): { type: string; label: string; nodes: OntologyNode[] }[]`, `filterNodes(nodes, q): OntologyNode[]`, `registryIdFor(node): string | null` in `ontologyStore.ts`.

- [ ] **Step 1: Write the failing tests** — create `client/test/ontologyStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupNodes, filterNodes, registryIdFor } from "../src/lib/ontologyStore";
import type { OntologyNode } from "../src/lib/types";

const n = (over: Partial<OntologyNode>): OntologyNode => ({
  type: "service", id: "service-x", title: "X", managed: "system",
  props: {}, relationships: [], ...over,
});

describe("groupNodes", () => {
  it("groups by type in fixed order and omits empty sections", () => {
    const groups = groupNodes([
      n({ type: "datasource", id: "datasource-a", title: "a" }),
      n({ type: "dashboard", id: "dashboard-d1", title: "d1" }),
      n({ type: "service", id: "service-s", title: "S" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Dashboards", "Services", "Data sources"]);
  });

  it("folds unknown types and domain entities into Domain", () => {
    const groups = groupNodes([
      n({ type: "entity", id: "customer-1", title: "Acme", managed: "domain" }),
      n({ type: "weird", id: "w-1", title: "w" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Domain");
    expect(groups[0].nodes.map((x) => x.id)).toEqual(["customer-1", "w-1"]);
  });
});

describe("filterNodes", () => {
  const nodes = [
    n({ id: "service-poller", title: "Print poller", props: { host: "192.168.1.95" } }),
    n({ id: "service-api", title: "API" }),
  ];
  it("matches id, title, and prop values case-insensitively", () => {
    expect(filterNodes(nodes, "POLLER")).toHaveLength(1);
    expect(filterNodes(nodes, "192.168")).toHaveLength(1);
    expect(filterNodes(nodes, "print")).toHaveLength(1);
  });
  it("empty query returns everything", () => {
    expect(filterNodes(nodes, "  ")).toHaveLength(2);
  });
});

describe("registryIdFor", () => {
  it("maps dashboard nodes to their registry id and others to null", () => {
    expect(registryIdFor(n({ type: "dashboard", id: "dashboard-spools" }))).toBe("spools");
    expect(registryIdFor(n({ type: "service", id: "service-x" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/ontologyStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** Append to `client/src/lib/types.ts`:

```ts
// Mirrors agent-host/src/ontology/types.ts (polyglot by contract, like AgentEvent).
export interface OntologyNode {
  type: string;
  id: string;
  title: string;
  managed: "system" | "domain";
  created?: string;
  updated?: string;
  props: Record<string, string>;
  relationships: { edge: string; target: string }[];
}

export interface OntologySnapshot {
  nodes: OntologyNode[];
  syncedAt: string | null;
  syncError: string | null;
}
```

Append to `client/src/lib/tauri.ts` (import `OntologySnapshot` from `./types` alongside the existing type imports):

```ts
export function getOntology(agentBase: string): Promise<OntologySnapshot> {
  return invoke<OntologySnapshot>("get_ontology", { agentBase });
}
```

Create `client/src/lib/ontologyStore.ts`:

```ts
import type { OntologyNode } from "./types";

// Fixed sidebar order — the ontology's type scheme IS the nav taxonomy.
const SECTIONS: { type: string; label: string }[] = [
  { type: "dashboard", label: "Dashboards" },
  { type: "service", label: "Services" },
  { type: "container", label: "Containers" },
  { type: "datasource", label: "Data sources" },
  { type: "vm", label: "VMs" },
];
const DOMAIN_LABEL = "Domain";

export function groupNodes(nodes: OntologyNode[]): { type: string; label: string; nodes: OntologyNode[] }[] {
  const known = new Set(SECTIONS.map((s) => s.type));
  const groups = SECTIONS.map((s) => ({
    ...s,
    nodes: nodes.filter((n) => n.type === s.type),
  }));
  // entity nodes plus anything with a type this client doesn't know yet
  groups.push({ type: "entity", label: DOMAIN_LABEL, nodes: nodes.filter((n) => !known.has(n.type)) });
  return groups.filter((g) => g.nodes.length > 0);
}

export function filterNodes(nodes: OntologyNode[], query: string): OntologyNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  return nodes.filter(
    (n) =>
      n.id.toLowerCase().includes(q) ||
      n.title.toLowerCase().includes(q) ||
      Object.values(n.props).some((v) => v.toLowerCase().includes(q)),
  );
}

export function registryIdFor(node: OntologyNode): string | null {
  return node.type === "dashboard" ? node.id.replace(/^dashboard-/, "") : null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd client && npx vitest run test/ontologyStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/tauri.ts client/src/lib/ontologyStore.ts client/test/ontologyStore.test.ts
git commit -m "feat(client): ontology contract types, getOntology binding, sidebar grouping helpers"
```

---

### Task 7: `OntologyPanel` component

**Files:**
- Create: `client/src/components/OntologyPanel.tsx`
- Test: `client/test/OntologyPanel.test.tsx`

**Interfaces:**
- Consumes: `getOntology` (Task 6), `groupNodes`/`filterNodes`/`registryIdFor` (Task 6), `Tab` from `lib/registryStore`.
- Produces: `OntologyPanel({ agentBase, surfaceTabs, activeSurfaceId, onSelectSurface })` — dashboard nodes select surfaces on the canvas; other nodes expand inline.

- [ ] **Step 1: Write the failing tests** — create `client/test/OntologyPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OntologyPanel } from "../src/components/OntologyPanel";
import { getOntology } from "../src/lib/tauri";
import type { OntologySnapshot } from "../src/lib/types";

vi.mock("../src/lib/tauri", () => ({ getOntology: vi.fn() }));

const snap: OntologySnapshot = {
  syncedAt: "2026-07-09T12:00:00.000Z",
  syncError: null,
  nodes: [
    { type: "dashboard", id: "dashboard-spools", title: "spools", managed: "system", props: {}, relationships: [] },
    { type: "dashboard", id: "dashboard-ghost", title: "ghost", managed: "system", props: {}, relationships: [] },
    {
      type: "service", id: "service-poller", title: "Print poller", managed: "system",
      props: { host: "192.168.1.95", port: "3000", status: "healthy" },
      relationships: [{ edge: "runs-on", target: "container-105" }],
    },
  ],
};

const surfaceTabs = [{ id: "spools", title: "spools", url: "/surfaces/spools/" }];

function mount(over: Partial<OntologySnapshot> = {}, onSelect = vi.fn()) {
  (getOntology as ReturnType<typeof vi.fn>).mockResolvedValue({ ...snap, ...over });
  render(
    <OntologyPanel agentBase="http://a" surfaceTabs={surfaceTabs} activeSurfaceId={null} onSelectSurface={onSelect} />,
  );
  return onSelect;
}

beforeEach(() => vi.clearAllMocks());

describe("OntologyPanel", () => {
  it("renders sections from the fetched graph", async () => {
    mount();
    expect(await screen.findByText("Dashboards")).toBeTruthy();
    expect(screen.getByText("Services")).toBeTruthy();
    expect(screen.getByText("Print poller")).toBeTruthy();
  });

  it("clicking a live dashboard selects the surface; dead ones are disabled", async () => {
    const onSelect = mount();
    await userEvent.click(await screen.findByRole("button", { name: "spools" }));
    expect(onSelect).toHaveBeenCalledWith("spools");
    expect((screen.getByRole("button", { name: "ghost" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("expands a non-dashboard node into a detail card", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /Print poller/ }));
    expect(screen.getByText(/192\.168\.1\.95/)).toBeTruthy();
    expect(screen.getByText(/runs-on → container-105/)).toBeTruthy();
  });

  it("filters all sections", async () => {
    mount();
    await screen.findByText("Dashboards");
    await userEvent.type(screen.getByPlaceholderText(/filter/i), "poller");
    expect(screen.queryByText("Dashboards")).toBeNull();
    expect(screen.getByText("Print poller")).toBeTruthy();
  });

  it("shows a sync-error banner", async () => {
    mount({ syncError: "projector broke" });
    expect(await screen.findByText(/projector broke/)).toBeTruthy();
  });

  it("shows fetch errors", async () => {
    (getOntology as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    render(
      <OntologyPanel agentBase="http://a" surfaceTabs={[]} activeSurfaceId={null} onSelectSurface={vi.fn()} />,
    );
    expect(await screen.findByText(/offline/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/OntologyPanel.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement** — create `client/src/components/OntologyPanel.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { getOntology } from "../lib/tauri";
import { groupNodes, filterNodes, registryIdFor } from "../lib/ontologyStore";
import type { OntologyNode, OntologySnapshot } from "../lib/types";
import type { Tab } from "../lib/registryStore";

export function OntologyPanel({
  agentBase,
  surfaceTabs,
  activeSurfaceId,
  onSelectSurface,
}: {
  agentBase: string;
  surfaceTabs: Tab[];
  activeSurfaceId: string | null;
  onSelectSurface: (id: string) => void;
}) {
  const [snap, setSnap] = useState<OntologySnapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnap(await getOntology(agentBase));
      setFetchError(null);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    }
  }, [agentBase]);

  useEffect(() => {
    void load();
  }, [load]);

  const error = fetchError ?? snap?.syncError ?? null;
  const groups = snap ? groupNodes(filterNodes(snap.nodes, query)) : [];

  const row = (n: OntologyNode) => {
    const rid = registryIdFor(n);
    if (rid !== null) {
      const live = surfaceTabs.some((t) => t.id === rid);
      return (
        <button
          onClick={() => onSelectSurface(rid)}
          disabled={!live}
          aria-current={rid === activeSurfaceId ? "true" : undefined}
          className={
            rid === activeSurfaceId
              ? "w-full rounded bg-raised px-2 py-1.5 text-left text-sm text-ink border border-line"
              : "w-full rounded px-2 py-1.5 text-left text-sm text-muted hover:text-ink hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          }
        >
          <span className="block truncate">{n.title}</span>
        </button>
      );
    }
    const open = expanded === n.id;
    return (
      <>
        <button
          onClick={() => setExpanded(open ? null : n.id)}
          aria-expanded={open}
          className="w-full rounded px-2 py-1.5 text-left text-sm text-muted hover:text-ink hover:bg-raised"
        >
          <span className="block truncate">{n.title}</span>
        </button>
        {open && (
          <div className="mx-2 mb-1 rounded border border-line bg-raised px-2 py-1.5 text-xs text-muted">
            <div className="mb-1 text-[10px] uppercase tracking-wide">{n.managed}</div>
            {Object.entries(n.props).map(([k, v]) => (
              <div key={k} className="truncate">
                {k}: {v}
              </div>
            ))}
            {n.relationships.map((r) => (
              <div key={`${r.edge}:${r.target}`} className="truncate">
                {r.edge} → {r.target}
              </div>
            ))}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">System map</h2>
        <button
          aria-label="Refresh"
          title={snap?.syncedAt ? `synced ${new Date(snap.syncedAt).toLocaleTimeString()}` : "Refresh"}
          onClick={() => void load()}
          className="rounded px-1 text-muted hover:text-ink"
        >
          ↻
        </button>
      </div>
      {error && (
        <p className="rounded border border-line bg-raised px-2 py-1 text-xs text-muted">sync problem: {error}</p>
      )}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter…"
        className="rounded border border-line bg-raised px-2 py-1 text-sm text-ink placeholder:text-muted"
      />
      {groups.map((g) => (
        <section key={g.type}>
          <h3 className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{g.label}</h3>
          <ul className="flex flex-col gap-0.5">
            {g.nodes.map((n) => (
              <li key={n.id}>{row(n)}</li>
            ))}
          </ul>
        </section>
      ))}
      {snap && groups.length === 0 && (
        <p className="px-2 py-4 text-center text-xs text-muted">Nothing on the map yet.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd client && npx vitest run test/OntologyPanel.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/OntologyPanel.tsx client/test/OntologyPanel.test.tsx
git commit -m "feat(client): OntologyPanel — ontology-organized System map sidebar"
```

---

### Task 8: Swap the sidebar — Workspace + Rail, delete SurfacesPanel

**Files:**
- Modify: `client/src/components/Workspace.tsx` (replace SurfacesPanel usage)
- Modify: `client/src/components/Rail.tsx` (label "Surfaces" → "System map")
- Delete: `client/src/components/SurfacesPanel.tsx`
- Test: `client/test/Workspace.test.tsx` (update mocks + button names)

**Interfaces:**
- Consumes: `OntologyPanel` (Task 7).

- [ ] **Step 1: Update the tests first** in `client/test/Workspace.test.tsx`: add `getOntology: vi.fn().mockResolvedValue({ nodes: [], syncedAt: null, syncError: null }),` inside the existing `vi.mock("../src/lib/tauri", ...)` factory, and change every `getByRole("button", { name: "Surfaces" })` to `{ name: "System map" }` (the rail assertion text too).

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/Workspace.test.tsx`
Expected: FAIL — no "System map" button yet.

- [ ] **Step 3: Implement.** In `client/src/components/Rail.tsx` change the item label:

```ts
const ITEMS: { id: RailSection; label: string; glyph: string }[] = [
  { id: "sessions", label: "Sessions", glyph: "💬" },
  { id: "surfaces", label: "System map", glyph: "▦" },
];
```

In `client/src/components/Workspace.tsx`: replace the `SurfacesPanel` import with `import { OntologyPanel } from "./OntologyPanel";` and replace the `{section === "surfaces" && ...}` block with:

```tsx
          {section === "surfaces" && (
            <OntologyPanel
              agentBase={agentBase}
              surfaceTabs={surfTabs}
              activeSurfaceId={activeSurf}
              onSelectSurface={setActiveSurf}
            />
          )}
```

Then delete the now-unreferenced flat list:

```bash
git rm client/src/components/SurfacesPanel.tsx
```

- [ ] **Step 4: Run the full client suite**

Run: `cd client && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests pass (no test file imports SurfacesPanel — verify with `grep -rn SurfacesPanel client/src client/test`, expect zero hits).

- [ ] **Step 5: Commit**

```bash
git add -A client/src client/test
git commit -m "feat(client): sidebar becomes the ontology System map; drop flat SurfacesPanel"
```

---

### Task 9: Full verification + PR

- [ ] **Step 1: Run everything**

```bash
cd agent-host && npx vitest run && npm run build
cd ../dashboard-host && npx vitest run
cd ../client && npx tsc --noEmit && npx vitest run
cd src-tauri && cargo test --quiet
```

Expected: all green, builds clean.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/ontology-reader
gh pr create --base main --title "feat: ontology reader — the sidebar becomes the system map" --body "<summarize spec: consumers, sync-on-read F16 fix, visible sync errors, prompt wiring; link docs/superpowers/specs/2026-07-09-ontology-reader-design.md>"
```
