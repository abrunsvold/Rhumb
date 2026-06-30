# Dashboard Host Implementation Plan (RHUMBR — Plan 2 of 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the **dashboard host** — a server-side process that watches the workspace, serves Claude-built `file` surfaces at stable tailnet URLs, and exposes the registry the Tauri client reads.

**Architecture:** A standalone Node/TypeScript process (its own `dashboard-host/` package, separate from the agent host, communicating only over HTTP). A file watcher rescans `<workspace>/surfaces/` and pushes registry snapshots; an Express server exposes `GET /registry`, `GET /registry/stream` (SSE), and a path-traversal-guarded `GET /surfaces/:id/*` static handler. The watch source is dependency-injected so the watcher is unit-testable without real filesystem timing.

**Tech Stack:** TypeScript (strict), Node ≥ 20, Express 4, chokidar 3 (file watching), Vitest + Supertest.

## Global Constraints

- **Runtime:** Node ≥ 20, TypeScript `strict: true`, ES modules (`"type": "module"`); local imports use the `.js` extension.
- **No auth token:** this host does NOT call Claude and has no `CLAUDE_CODE_OAUTH_TOKEN`. It is unauthenticated and is only ever exposed on the tailnet — the README must say so.
- **Workspace:** surfaces live under `<RHUMBR_WORKSPACE>/surfaces/` (default workspace `./workspace`). Port from `RHUMBR_DASHBOARD_PORT` (default 8788 — distinct from the agent host's 8787).
- **Surface contract:** a surface is a folder `<workspace>/surfaces/<id>/` containing `surface.json` (`{ id, title, kind:"file", entry, created, updated }`) plus static artifacts. `id` MUST equal the folder name and match `^[A-Za-z0-9._-]+$`. An invalid/partial surface is skipped (logged), never fatal.
- **Registry entry shape (client-facing):** `{ id, title, url, kind, created, updated }` where `url` is `/surfaces/<id>/`. `entry` is internal (used for serving) and is NOT in the client-facing entry.
- **Security:** the static handler must never serve a path outside the requested surface's folder (path-traversal → 404).
- **Scope:** `file` surfaces only. Keep `kind` in the contract so `service` surfaces (Plan 6) slot in unchanged. No data endpoint (Plan 4). No debounce on the watcher in v1 (rescan-on-change is acceptable; debounce is a later optimization).

---

### Task 1: Scaffold + config + wire types

**Files:**
- Create: `dashboard-host/package.json`, `dashboard-host/tsconfig.json`, `dashboard-host/vitest.config.ts`
- Create: `dashboard-host/src/config.ts`, `dashboard-host/src/types.ts`
- Test: `dashboard-host/test/config.test.ts`

**Interfaces:**
- Produces: `interface Config { port: number; workspace: string }` and `loadConfig(env: NodeJS.ProcessEnv): Config`.
- Produces (types.ts): `SurfaceMeta`, `RegistryEntry`, `RegistrySnapshot`, `RegistryEvent` (below).

- [ ] **Step 1: Create `dashboard-host/package.json`**

```json
{
  "name": "rhumbr-dashboard-host",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "chokidar": "^3.6.0",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.0",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `dashboard-host/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `dashboard-host/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 4: Install dependencies**

Run: `cd dashboard-host && npm install`
Expected: completes with a `node_modules/` directory, exit 0.

- [ ] **Step 5: Create `dashboard-host/src/types.ts`**

```typescript
export interface SurfaceMeta {
  id: string;
  title: string;
  kind: "file";
  entry: string;
  created: string;
  updated: string;
}

export interface RegistryEntry {
  id: string;
  title: string;
  url: string;
  kind: string;
  created: string;
  updated: string;
}

export interface RegistrySnapshot {
  surfaces: RegistryEntry[];
}

export type RegistryEvent = { type: "registry" } & RegistrySnapshot;
```

- [ ] **Step 6: Write the failing test** — `dashboard-host/test/config.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults from an empty env", () => {
    expect(loadConfig({})).toEqual({ port: 8788, workspace: "./workspace" });
  });

  it("honors overrides", () => {
    expect(
      loadConfig({ RHUMBR_DASHBOARD_PORT: "9100", RHUMBR_WORKSPACE: "/srv/ws" }),
    ).toEqual({ port: 9100, workspace: "/srv/ws" });
  });

  it("throws when RHUMBR_DASHBOARD_PORT is not numeric", () => {
    expect(() => loadConfig({ RHUMBR_DASHBOARD_PORT: "abc" })).toThrow(
      /RHUMBR_DASHBOARD_PORT/,
    );
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 8: Write the implementation** — `dashboard-host/src/config.ts`

```typescript
export interface Config {
  port: number;
  workspace: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  let port = 8788;
  if (env.RHUMBR_DASHBOARD_PORT) {
    const parsed = Number.parseInt(env.RHUMBR_DASHBOARD_PORT, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(
        `RHUMBR_DASHBOARD_PORT must be a number, got "${env.RHUMBR_DASHBOARD_PORT}"`,
      );
    }
    port = parsed;
  }
  return {
    port,
    workspace: env.RHUMBR_WORKSPACE?.trim() || "./workspace",
  };
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 10: Commit**

```bash
git add dashboard-host/package.json dashboard-host/tsconfig.json dashboard-host/vitest.config.ts dashboard-host/src/config.ts dashboard-host/src/types.ts dashboard-host/test/config.test.ts dashboard-host/package-lock.json
git commit -m "feat(dashboard-host): scaffold project, config loader, wire types"
```

---

### Task 2: SSE writer

**Files:**
- Create: `dashboard-host/src/sse.ts`
- Test: `dashboard-host/test/sse.test.ts`

**Interfaces:**
- Consumes: `RegistryEvent` (Task 1).
- Produces: `writeSseEvent(res: { write(chunk: string): void }, event: RegistryEvent): void` — one SSE `data:` frame + blank line.

- [ ] **Step 1: Write the failing test** — `dashboard-host/test/sse.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { writeSseEvent } from "../src/sse.js";

describe("writeSseEvent", () => {
  it("serializes a registry event as a single-line JSON SSE frame", () => {
    const chunks: string[] = [];
    writeSseEvent({ write: (c) => chunks.push(c) }, {
      type: "registry",
      surfaces: [
        { id: "a", title: "A", url: "/surfaces/a/", kind: "file", created: "t", updated: "t" },
      ],
    });
    const out = chunks.join("");
    expect(out.startsWith("data: ")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(true);
    expect(out.split("\n").filter((l) => l.startsWith("data: ")).length).toBe(1);
    const json = JSON.parse(out.slice("data: ".length).trim());
    expect(json.type).toBe("registry");
    expect(json.surfaces[0].url).toBe("/surfaces/a/");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/sse.test.ts`
Expected: FAIL — cannot resolve `../src/sse.js`.

- [ ] **Step 3: Write the implementation** — `dashboard-host/src/sse.ts`

```typescript
import type { RegistryEvent } from "./types.js";

export function writeSseEvent(
  res: { write(chunk: string): void },
  event: RegistryEvent,
): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/sse.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src/sse.ts dashboard-host/test/sse.test.ts
git commit -m "feat(dashboard-host): SSE writer for registry events"
```

---

### Task 3: Registry — parse, scan, snapshot

**Files:**
- Create: `dashboard-host/src/registry.ts`
- Test: `dashboard-host/test/registry.test.ts`

**Interfaces:**
- Consumes: `SurfaceMeta`, `RegistrySnapshot`, `RegistryEntry` (Task 1).
- Produces:
  - `readSurfaceMeta(dir: string): SurfaceMeta | null` — reads `<dir>/surface.json`, validates, returns null on any problem.
  - `scanSurfaces(root: string): SurfaceMeta[]` — returns valid surfaces under `root` (the `surfaces/` dir). Returns `[]` if `root` doesn't exist.
  - `toSnapshot(metas: SurfaceMeta[]): RegistrySnapshot` — maps to client-facing entries with `url`.

- [ ] **Step 1: Write the failing test** — `dashboard-host/test/registry.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSurfaceMeta, scanSurfaces, toSnapshot } from "../src/registry.js";

let root: string;

function writeSurface(id: string, meta: unknown, withEntry = true): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "surface.json"), JSON.stringify(meta));
  if (withEntry) writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  return dir;
}

const valid = (id: string) => ({
  id,
  title: `Title ${id}`,
  kind: "file",
  entry: "index.html",
  created: "2026-06-30T00:00:00Z",
  updated: "2026-06-30T00:00:00Z",
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rhumbr-surfaces-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readSurfaceMeta", () => {
  it("parses a valid surface.json", () => {
    const dir = writeSurface("dash1", valid("dash1"));
    expect(readSurfaceMeta(dir)).toEqual(valid("dash1"));
  });

  it("returns null when surface.json is missing", () => {
    const dir = join(root, "empty");
    mkdirSync(dir, { recursive: true });
    expect(readSurfaceMeta(dir)).toBeNull();
  });

  it("returns null when id does not match the folder name", () => {
    const dir = writeSurface("dash2", { ...valid("dash2"), id: "other" });
    expect(readSurfaceMeta(dir)).toBeNull();
  });

  it("returns null when id has unsafe characters", () => {
    const dir = writeSurface("bad", { ...valid("bad"), id: "../bad" });
    expect(readSurfaceMeta(dir)).toBeNull();
  });

  it("returns null when surface.json is malformed", () => {
    const dir = join(root, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "surface.json"), "{ not json");
    expect(readSurfaceMeta(dir)).toBeNull();
  });
});

describe("scanSurfaces", () => {
  it("returns only valid surfaces and skips invalid ones", () => {
    writeSurface("dash1", valid("dash1"));
    writeSurface("dash2", valid("dash2"));
    writeSurface("dash3", { ...valid("dash3"), kind: "service" }); // wrong kind → skipped
    const ids = scanSurfaces(root).map((m) => m.id).sort();
    expect(ids).toEqual(["dash1", "dash2"]);
  });

  it("returns [] when the root does not exist", () => {
    expect(scanSurfaces(join(root, "nope"))).toEqual([]);
  });
});

describe("toSnapshot", () => {
  it("maps metas to client-facing entries with a url and without entry", () => {
    const snap = toSnapshot([valid("dash1")]);
    expect(snap).toEqual({
      surfaces: [
        {
          id: "dash1",
          title: "Title dash1",
          url: "/surfaces/dash1/",
          kind: "file",
          created: "2026-06-30T00:00:00Z",
          updated: "2026-06-30T00:00:00Z",
        },
      ],
    });
    expect("entry" in snap.surfaces[0]).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/registry.test.ts`
Expected: FAIL — cannot resolve `../src/registry.js`.

- [ ] **Step 3: Write the implementation** — `dashboard-host/src/registry.ts`

```typescript
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { SurfaceMeta, RegistrySnapshot } from "./types.js";

const ID_RE = /^[A-Za-z0-9._-]+$/;

export function readSurfaceMeta(dir: string): SurfaceMeta | null {
  const file = join(dir, "surface.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const folder = basename(dir);
  if (
    typeof m.id !== "string" ||
    m.id !== folder ||
    !ID_RE.test(m.id) ||
    m.kind !== "file" ||
    typeof m.title !== "string" ||
    typeof m.entry !== "string" ||
    m.entry.length === 0 ||
    typeof m.created !== "string" ||
    typeof m.updated !== "string"
  ) {
    return null;
  }
  return {
    id: m.id,
    title: m.title,
    kind: "file",
    entry: m.entry,
    created: m.created,
    updated: m.updated,
  };
}

export function scanSurfaces(root: string): SurfaceMeta[] {
  if (!existsSync(root)) return [];
  const out: SurfaceMeta[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const meta = readSurfaceMeta(dir);
    if (meta) out.push(meta);
  }
  return out;
}

export function toSnapshot(metas: SurfaceMeta[]): RegistrySnapshot {
  return {
    surfaces: metas.map((m) => ({
      id: m.id,
      title: m.title,
      url: `/surfaces/${m.id}/`,
      kind: m.kind,
      created: m.created,
      updated: m.updated,
    })),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/registry.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src/registry.ts dashboard-host/test/registry.test.ts
git commit -m "feat(dashboard-host): surface parsing, scanning, and snapshot mapping"
```

---

### Task 4: Watcher (injected watch source)

**Files:**
- Create: `dashboard-host/src/watcher.ts`
- Test: `dashboard-host/test/watcher.test.ts`

**Interfaces:**
- Consumes: `scanSurfaces`, `toSnapshot` (Task 3); `RegistrySnapshot` (Task 1).
- Produces:
  - `type WatchFn = (dir: string, onChange: () => void) => { close(): void }`
  - `startWatcher(opts: { root: string; onSnapshot: (s: RegistrySnapshot) => void; watch: WatchFn }): { close(): void }` — pushes one snapshot immediately, then a fresh snapshot on every `onChange`.

- [ ] **Step 1: Write the failing test** — `dashboard-host/test/watcher.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWatcher, type WatchFn } from "../src/watcher.js";
import type { RegistrySnapshot } from "../src/types.js";

let root: string;

function writeSurface(id: string): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "surface.json"),
    JSON.stringify({
      id,
      title: id,
      kind: "file",
      entry: "index.html",
      created: "t",
      updated: "t",
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rhumbr-watch-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("startWatcher", () => {
  it("emits an initial snapshot then re-emits on each change", () => {
    writeSurface("d1");
    const snaps: RegistrySnapshot[] = [];
    let trigger: () => void = () => {};
    const watch: WatchFn = (_dir, onChange) => {
      trigger = onChange;
      return { close() {} };
    };

    startWatcher({ root, onSnapshot: (s) => snaps.push(s), watch });

    expect(snaps).toHaveLength(1);
    expect(snaps[0].surfaces.map((s) => s.id)).toEqual(["d1"]);

    writeSurface("d2");
    trigger();

    expect(snaps).toHaveLength(2);
    expect(snaps[1].surfaces.map((s) => s.id).sort()).toEqual(["d1", "d2"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/watcher.test.ts`
Expected: FAIL — cannot resolve `../src/watcher.js`.

- [ ] **Step 3: Write the implementation** — `dashboard-host/src/watcher.ts`

```typescript
import { scanSurfaces, toSnapshot } from "./registry.js";
import type { RegistrySnapshot } from "./types.js";

export type WatchFn = (
  dir: string,
  onChange: () => void,
) => { close(): void };

export function startWatcher(opts: {
  root: string;
  onSnapshot: (s: RegistrySnapshot) => void;
  watch: WatchFn;
}): { close(): void } {
  const rebuild = () => opts.onSnapshot(toSnapshot(scanSurfaces(opts.root)));
  rebuild(); // initial snapshot
  return opts.watch(opts.root, rebuild);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/watcher.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src/watcher.ts dashboard-host/test/watcher.test.ts
git commit -m "feat(dashboard-host): registry watcher with injectable watch source"
```

---

### Task 5: HTTP server (registry, SSE, guarded static)

**Files:**
- Create: `dashboard-host/src/server.ts`
- Test: `dashboard-host/test/server.test.ts`

**Interfaces:**
- Consumes: `RegistrySnapshot`, `RegistryEntry` (Task 1); `readSurfaceMeta` (Task 3); `writeSseEvent` (Task 2).
- Produces: `createServer(deps: { getSnapshot: () => RegistrySnapshot; workspace: string; subscribers: Set<import("express").Response> }): import("express").Express` exposing:
  - `GET /registry` → `getSnapshot()`.
  - `GET /registry/stream` → SSE; writes the current snapshot once, registers the response in `subscribers`, removes it on close.
  - `GET /surfaces/:id` and `GET /surfaces/:id/*` → static files from `<workspace>/surfaces/:id/`; a bare directory serves that surface's `entry`; path-traversal → 404.
  - `GET /healthz` → `{ ok: true }`.

- [ ] **Step 1: Write the failing test** — `dashboard-host/test/server.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import { createServer } from "../src/server.js";
import type { RegistrySnapshot } from "../src/types.js";

let workspace: string;

function writeSurface(id: string, entry = "index.html", body = "<h1>hi</h1>"): void {
  const dir = join(workspace, "surfaces", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "surface.json"),
    JSON.stringify({ id, title: id, kind: "file", entry, created: "t", updated: "t" }),
  );
  writeFileSync(join(dir, entry), body);
}

const snapshot: RegistrySnapshot = {
  surfaces: [
    { id: "d1", title: "d1", url: "/surfaces/d1/", kind: "file", created: "t", updated: "t" },
  ],
};

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rhumbr-srv-"));
  // a secret file OUTSIDE the surface, to prove traversal is blocked
  writeFileSync(join(workspace, "secret.txt"), "TOP SECRET");
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function app(snap: RegistrySnapshot = snapshot) {
  return createServer({
    getSnapshot: () => snap,
    workspace,
    subscribers: new Set<Response>(),
  });
}

describe("dashboard-host server", () => {
  it("GET /healthz returns ok", async () => {
    const res = await request(app()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("GET /registry returns the current snapshot", async () => {
    const res = await request(app()).get("/registry");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(snapshot);
  });

  it("GET /surfaces/:id/ serves the surface entry file", async () => {
    writeSurface("d1");
    const res = await request(app()).get("/surfaces/d1/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<h1>hi</h1>");
  });

  it("GET /surfaces/:id (no trailing slash) also serves the entry", async () => {
    writeSurface("d1");
    const res = await request(app()).get("/surfaces/d1");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<h1>hi</h1>");
  });

  it("serves a named asset within the surface", async () => {
    writeSurface("d1");
    mkdirSync(join(workspace, "surfaces", "d1"), { recursive: true });
    writeFileSync(join(workspace, "surfaces", "d1", "app.js"), "console.log(1)");
    const res = await request(app()).get("/surfaces/d1/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("console.log(1)");
  });

  it("blocks path traversal out of the surface folder", async () => {
    writeSurface("d1");
    const res = await request(app()).get("/surfaces/d1/..%2f..%2fsecret.txt");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("TOP SECRET");
  });

  it("rejects an unsafe surface id", async () => {
    const res = await request(app()).get("/surfaces/..%2f..%2fsecret.txt/");
    expect(res.status).toBe(404);
  });

  it("404s a missing surface", async () => {
    const res = await request(app()).get("/surfaces/nope/");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/server.test.ts`
Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 3: Write the implementation** — `dashboard-host/src/server.ts`

```typescript
import express, { type Express, type Request, type Response } from "express";
import { resolve, sep } from "node:path";
import { readSurfaceMeta } from "./registry.js";
import { writeSseEvent } from "./sse.js";
import type { RegistrySnapshot } from "./types.js";

const ID_RE = /^[A-Za-z0-9._-]+$/;

export function createServer(deps: {
  getSnapshot: () => RegistrySnapshot;
  workspace: string;
  subscribers: Set<Response>;
}): Express {
  const app = express();
  const surfacesRoot = resolve(deps.workspace, "surfaces");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/registry", (_req, res) => {
    res.json(deps.getSnapshot());
  });

  app.get("/registry/stream", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    writeSseEvent(res, { type: "registry", ...deps.getSnapshot() });
    deps.subscribers.add(res);
    req.on("close", () => deps.subscribers.delete(res));
  });

  const serveSurface = (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!ID_RE.test(id)) {
      res.sendStatus(404);
      return;
    }
    const surfaceDir = resolve(surfacesRoot, id);
    // Decode and normalize the sub-path; default to the surface's entry.
    let rel = "";
    try {
      rel = decodeURIComponent((req.params[0] as string | undefined) ?? "");
    } catch {
      res.sendStatus(404);
      return;
    }
    if (rel === "" || rel.endsWith("/")) {
      const meta = readSurfaceMeta(surfaceDir);
      if (!meta) {
        res.sendStatus(404);
        return;
      }
      rel = rel + meta.entry;
    }
    const target = resolve(surfaceDir, rel);
    const within = target === surfaceDir || target.startsWith(surfaceDir + sep);
    if (!within) {
      res.sendStatus(404);
      return;
    }
    res.sendFile(target, (err) => {
      if (err) res.sendStatus(404);
    });
  };

  app.get("/surfaces/:id", serveSurface);
  app.get("/surfaces/:id/*", serveSurface);

  return app;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/server.test.ts`
Expected: PASS (8 tests). If the `/surfaces/:id/*` route does not populate `req.params[0]` on your Express version, confirm Express 4 is installed (the `*` splat param is `req.params[0]` in Express 4).

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src/server.ts dashboard-host/test/server.test.ts
git commit -m "feat(dashboard-host): registry, SSE, and traversal-guarded static routes"
```

---

### Task 6: Entrypoint, chokidar wiring, README

**Files:**
- Create: `dashboard-host/src/index.ts`, `dashboard-host/README.md`, `dashboard-host/.gitignore`
- Test: `dashboard-host/test/index.smoke.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `createServer` (Task 5), `startWatcher` + `WatchFn` (Task 4), `writeSseEvent` (Task 2), `RegistrySnapshot` (Task 1).
- Produces: `buildApp(deps: { config: Config; watch: WatchFn }): import("express").Express` (testable with an injected watch), and a `main()` that wires chokidar, creates `<workspace>/surfaces`, and listens.

- [ ] **Step 1: Write the failing smoke test** — `dashboard-host/test/index.smoke.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index.js";
import type { WatchFn } from "../src/watcher.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rhumbr-idx-"));
  const dir = join(workspace, "surfaces", "d1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "surface.json"),
    JSON.stringify({ id: "d1", title: "Dash One", kind: "file", entry: "index.html", created: "t", updated: "t" }),
  );
  writeFileSync(join(dir, "index.html"), "<h1>one</h1>");
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("buildApp wiring", () => {
  it("serves the registry seeded by the initial watcher scan and the surface entry", async () => {
    const noopWatch: WatchFn = () => ({ close() {} });
    const app = buildApp({ config: { port: 0, workspace }, watch: noopWatch });

    const reg = await request(app).get("/registry");
    expect(reg.status).toBe(200);
    expect(reg.body.surfaces.map((s: { id: string }) => s.id)).toEqual(["d1"]);
    expect(reg.body.surfaces[0].url).toBe("/surfaces/d1/");

    const page = await request(app).get("/surfaces/d1/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("<h1>one</h1>");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/index.smoke.test.ts`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 3: Write the implementation** — `dashboard-host/src/index.ts`

```typescript
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import type { Express, Response } from "express";
import { loadConfig, type Config } from "./config.js";
import { createServer } from "./server.js";
import { startWatcher, type WatchFn } from "./watcher.js";
import { writeSseEvent } from "./sse.js";
import type { RegistrySnapshot } from "./types.js";

export function buildApp(deps: { config: Config; watch: WatchFn }): Express {
  const surfacesRoot = resolve(deps.config.workspace, "surfaces");
  const subscribers = new Set<Response>();
  let current: RegistrySnapshot = { surfaces: [] };

  const app = createServer({
    getSnapshot: () => current,
    workspace: deps.config.workspace,
    subscribers,
  });

  startWatcher({
    root: surfacesRoot,
    watch: deps.watch,
    onSnapshot: (snap) => {
      current = snap;
      for (const r of subscribers) writeSseEvent(r, { type: "registry", ...snap });
    },
  });

  return app;
}

// Production watch source backed by chokidar.
const chokidarWatch: WatchFn = (dir, onChange) => {
  const w = chokidar.watch(dir, { ignoreInitial: true });
  w.on("all", () => onChange());
  return { close: () => void w.close() };
};

export function main(): void {
  const config = loadConfig(process.env);
  mkdirSync(resolve(config.workspace, "surfaces"), { recursive: true });
  const app = buildApp({ config, watch: chokidarWatch });
  app.listen(config.port, () => {
    console.log(`rhumbr dashboard-host listening on :${config.port} (workspace ${config.workspace})`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `cd dashboard-host && npx vitest run test/index.smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `cd dashboard-host && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all tests PASS; `tsc` reports no errors.

- [ ] **Step 6: Create `dashboard-host/.gitignore`**

```
node_modules/
dist/
workspace/
```

- [ ] **Step 7: Create `dashboard-host/README.md`**

```markdown
# RHUMBR Dashboard Host

Watches the RHUMBR workspace and serves the `file` surfaces Claude Code builds at
stable URLs over your Tailscale network, plus the registry the desktop client reads.

> **Security.** This host is **unauthenticated** — it serves whatever is under
> `<workspace>/surfaces/`. Expose it **only** on your tailnet, never on a public
> interface. It does not call Claude and holds no credentials.

## Run

    npm install
    npm run build
    npm start

Environment variables: `RHUMBR_DASHBOARD_PORT` (default 8788), `RHUMBR_WORKSPACE`
(default `./workspace`).

## Surface contract

The agent creates a surface by writing a folder `<workspace>/surfaces/<id>/`:

    surface.json   { "id", "title", "kind": "file", "entry": "index.html", "created", "updated" }
    index.html     (and any other static assets)

`id` must equal the folder name and match `[A-Za-z0-9._-]+`. Invalid or partial
surfaces are skipped, never fatal.

## API

- `GET /registry` — `{ surfaces: [{ id, title, url, kind, created, updated }] }`.
- `GET /registry/stream` — Server-Sent Events; a fresh registry snapshot on connect
  and on every change.
- `GET /surfaces/:id/` (and `/surfaces/:id/<asset>`) — the surface's static files;
  a bare directory serves its `entry`. Paths outside the surface folder are refused.
- `GET /healthz` — `{ ok: true }`.
```

- [ ] **Step 8: Commit**

```bash
git add dashboard-host/src/index.ts dashboard-host/README.md dashboard-host/.gitignore dashboard-host/test/index.smoke.test.ts
git commit -m "feat(dashboard-host): entrypoint, chokidar wiring, README"
```

---

## Done criteria

- `cd dashboard-host && npm install && npx vitest run && npx tsc -p tsconfig.json --noEmit` all succeed.
- `npm run build && npm start` boots; `GET /healthz` returns `{ ok: true }`.
- Dropping a folder `<workspace>/surfaces/demo/` with a valid `surface.json` + `index.html` makes `GET /registry` list it and `GET /surfaces/demo/` serve it; a traversal path is refused with 404.

## Next plan

**Plan 3 — Tauri client**: the React desktop app that reads `/registry` (and the stream) from this host, renders surfaces as tabs/webviews over Tailscale, and embeds the agent-host session panel. It consumes the contracts established by Plans 1 and 2.
