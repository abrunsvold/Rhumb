# Rhumb Client Foundation Implementation Plan (Plan 3 of 7 — part A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the agent-host turn-streaming enhancement (Part 0) and the pure, unit-tested client-side foundation (event reducer, registry store, session tracking) that the Tauri/React shell (Plan 3b) will build on.

**Architecture:** Part 0 adds turn-scoped, stream-first SSE to the existing `agent-host/` package (additive, non-breaking). The client foundation is a new `client/` Vite + React + TypeScript package whose `src/lib/` holds framework-free reducers/stores that transform host wire events into view models — fully unit-testable without Tauri or a DOM.

**Tech Stack:** TypeScript (strict), Node ≥ 20, Express 4 (agent host), Vite + React 18, Vitest.

## Global Constraints

- **Runtime:** Node ≥ 20, TypeScript `strict: true`, ES modules; local imports use the `.js` extension in the agent-host package (matching its existing style). The `client/` Vite package uses bundler resolution and does NOT require `.js` import suffixes.
- **Part 0 is additive and non-breaking:** `/sessions/:id/stream` and existing `POST /messages` behavior stay; only a new `turnId` field and `/turns/:turnId/stream` route are added. Any existing agent-host test whose expectation changes MUST be updated in the same task.
- **Wire contracts (must match the hosts verbatim):** `AgentEvent = session | result | error | raw` (agent host); `RegistryEntry = { id, title, url, kind, created, updated }` and `RegistrySnapshot = { surfaces: RegistryEntry[] }` (dashboard host).
- **Foundation purity:** every `client/src/lib/` module is framework-free and deterministic — no `Date.now()`, no I/O, no React, no Tauri. Timestamps and ids are passed in by callers, so the functions are unit-testable.
- **Scope:** this plan is foundation only. No Tauri, no Rust, no React components, no networking — those are Plan 3b.

---

### Task 1: Agent-host turn-scoped streaming (Part 0)

**Files:**
- Modify: `agent-host/src/server.ts` (add turn subscribers + `/turns/:turnId/stream` + `turnId` fanout)
- Modify: `agent-host/test/server.test.ts` (update changed assertion; add turn-fanout test)

**Interfaces:**
- Consumes: `AgentEvent` (`agent-host/src/types.js`), `writeSseEvent` (`agent-host/src/sse.js`).
- Produces: `createServer(deps: { manager: ManagerLike; turnSubscribers?: Map<string, Set<import("express").Response> }): Express` — now also exposes `GET /turns/:turnId/stream` and accepts `turnId` on `POST /messages`; the 202 body becomes `{ sessionId, turnId }`.

- [ ] **Step 1: Update the existing 202 assertion + add the failing turn-fanout test** in `agent-host/test/server.test.ts`

First, find the existing test `"POST /messages with a prompt returns 202 and an echoed sessionId"`. Its assertion currently reads:

```typescript
    expect(res.body).toEqual({ sessionId: "sess-9" });
```

Change it to:

```typescript
    expect(res.body).toEqual({ sessionId: "sess-9", turnId: "" });
```

Then add this new test at the end of the `describe("agent-host server", ...)` block:

```typescript
  it("fans turn events to a /turns subscriber registered for that turnId", async () => {
    const written: string[] = [];
    const fakeRes = { write: (c: string) => written.push(c) } as unknown as import("express").Response;
    const turnSubscribers = new Map<string, Set<import("express").Response>>();
    turnSubscribers.set("t1", new Set([fakeRes]));

    const app = createServer({
      manager: fakeManager([
        { type: "session", sessionId: "s1" },
        { type: "result", result: "ok", isError: false },
      ]),
      turnSubscribers,
    });

    const res = await request(app).post("/messages").send({ turnId: "t1", prompt: "hi" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sessionId: "", turnId: "t1" });

    const frames = written.join("");
    expect(frames).toContain('"type":"session"');
    expect(frames).toContain('"type":"result"');
  });
```

(The existing `fakeManager` helper in this file emits its scripted events synchronously when `run` is called, so the writes land before the POST response resolves.)

- [ ] **Step 2: Run the tests to verify the new test fails (and the changed assertion)**

Run: `cd agent-host && npx vitest run test/server.test.ts`
Expected: FAIL — `createServer` does not accept `turnSubscribers` / no turn fanout; the changed assertion also fails until Step 3.

- [ ] **Step 3: Update `agent-host/src/server.ts`** — replace the whole file with:

```typescript
import express, { type Express, type Request, type Response } from "express";
import type { AgentEvent } from "./types.js";
import { writeSseEvent } from "./sse.js";

interface ManagerLike {
  run(
    prompt: string,
    sessionId: string | undefined,
    onEvent: (e: AgentEvent) => void,
  ): Promise<string>;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

function subsFor(map: Map<string, Set<Response>>, id: string): Set<Response> {
  let set = map.get(id);
  if (!set) {
    set = new Set();
    map.set(id, set);
  }
  return set;
}

export function createServer(deps: {
  manager: ManagerLike;
  turnSubscribers?: Map<string, Set<Response>>;
}): Express {
  const app = express();
  app.use(express.json());

  // session id -> SSE responses ("" is the pending bucket for new sessions).
  const subscribers = new Map<string, Set<Response>>();
  // turn id -> SSE responses (stream-first: client subscribes before posting).
  const turnSubscribers = deps.turnSubscribers ?? new Map<string, Set<Response>>();

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/sessions/:id/stream", (req: Request, res: Response) => {
    res.set(SSE_HEADERS);
    res.flushHeaders?.();
    const set = subsFor(subscribers, req.params.id);
    set.add(res);
    req.on("close", () => set.delete(res));
  });

  app.get("/turns/:turnId/stream", (req: Request, res: Response) => {
    res.set(SSE_HEADERS);
    res.flushHeaders?.();
    const set = subsFor(turnSubscribers, req.params.turnId);
    set.add(res);
    req.on("close", () => set.delete(res));
  });

  app.post("/messages", (req: Request, res: Response) => {
    const { sessionId, prompt, turnId } = req.body ?? {};
    if (typeof prompt !== "string" || prompt.length === 0) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    const inputId: string | undefined =
      typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
    const turn: string | undefined =
      typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;

    let targetId = inputId ?? "";

    const onEvent = (e: AgentEvent) => {
      if (e.type === "session" && e.sessionId && e.sessionId !== targetId) {
        const pending = subscribers.get(targetId);
        if (pending) {
          const dest = subsFor(subscribers, e.sessionId);
          for (const r of pending) dest.add(r);
          if (targetId === "") subscribers.delete("");
        }
        targetId = e.sessionId;
      }
      for (const r of subscribers.get(targetId) ?? []) writeSseEvent(r, e);
      if (turn) {
        for (const r of turnSubscribers.get(turn) ?? []) writeSseEvent(r, e);
      }
    };

    void deps.manager.run(prompt, inputId, onEvent);

    res.status(202).json({ sessionId: inputId ?? "", turnId: turn ?? "" });
  });

  return app;
}
```

- [ ] **Step 4: Run the full agent-host suite + typecheck**

Run: `cd agent-host && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all tests PASS (including the updated 202 assertion and the new turn-fanout test); `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/server.ts agent-host/test/server.test.ts
git commit -m "feat(agent-host): turn-scoped stream-first session streaming"
```

---

### Task 2: client/ scaffold + shared wire types

**Files:**
- Create: `client/package.json`, `client/tsconfig.json`, `client/vite.config.ts`, `client/index.html`, `client/src/main.tsx`, `client/src/lib/types.ts`
- Test: `client/test/types.test.ts`

**Interfaces:**
- Produces (`src/lib/types.ts`): `AgentEvent`, `RegistryEntry`, `RegistrySnapshot` — the client-side mirrors of the host wire contracts.

- [ ] **Step 1: Create `client/package.json`**

```json
{
  "name": "rhumb-client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.0",
    "vite": "^5.3.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `client/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ES2022",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `client/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: { environment: "node", include: ["test/**/*.test.ts"], globals: true },
});
```

- [ ] **Step 4: Create `client/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Rhumb</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `client/src/main.tsx`** (minimal placeholder shell — real UI is Plan 3b)

```tsx
import { createRoot } from "react-dom/client";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(<div>Rhumb client (foundation)</div>);
}
```

- [ ] **Step 6: Create `client/src/lib/types.ts`**

```typescript
export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "result"; result: string; isError: boolean }
  | { type: "error"; message: string }
  | { type: "raw"; message: unknown };

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
```

- [ ] **Step 7: Install dependencies**

Run: `cd client && npm install`
Expected: completes with a `node_modules/` directory, exit 0.

- [ ] **Step 8: Write the anchor test** — `client/test/types.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import type { AgentEvent, RegistrySnapshot } from "../src/lib/types";

describe("wire types", () => {
  it("AgentEvent and RegistrySnapshot are usable as the host contracts", () => {
    const e: AgentEvent = { type: "session", sessionId: "s1" };
    const snap: RegistrySnapshot = {
      surfaces: [
        { id: "a", title: "A", url: "/surfaces/a/", kind: "file", created: "t", updated: "t" },
      ],
    };
    expect(e.type).toBe("session");
    expect(snap.surfaces[0].url).toBe("/surfaces/a/");
  });
});
```

- [ ] **Step 9: Run the test + typecheck**

Run: `cd client && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (1 test); `tsc` clean.

- [ ] **Step 10: Create `client/.gitignore`**

```
node_modules/
dist/
src-tauri/target/
```

- [ ] **Step 11: Commit**

```bash
git add client/package.json client/tsconfig.json client/vite.config.ts client/index.html client/src/main.tsx client/src/lib/types.ts client/test/types.test.ts client/.gitignore client/package-lock.json
git commit -m "feat(client): scaffold Vite/React/TS project and wire types"
```

---

### Task 3: Agent-event reducer (`lib/agentEvents.ts`)

**Files:**
- Create: `client/src/lib/agentEvents.ts`
- Test: `client/test/agentEvents.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` (Task 2).
- Produces:
  - `interface TranscriptMessage { kind: "text" | "result" | "error" | "tool"; text: string; toolName?: string; toolInput?: unknown }`
  - `interface AgentState { sessionId: string | null; messages: TranscriptMessage[] }`
  - `const initialAgentState: AgentState`
  - `reduceAgent(state: AgentState, event: AgentEvent): AgentState` — pure; maps `session`→sessionId, `result`/`error`→a message, `raw`→0+ messages extracted best-effort from an SDK assistant message (`text` blocks → text messages, `tool_use` blocks → tool messages); unrecognized `raw` → no messages.

- [ ] **Step 1: Write the failing test** — `client/test/agentEvents.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { reduceAgent, initialAgentState, type AgentState } from "../src/lib/agentEvents";
import type { AgentEvent } from "../src/lib/types";

function run(events: AgentEvent[]): AgentState {
  return events.reduce(reduceAgent, initialAgentState);
}

describe("reduceAgent", () => {
  it("records the session id from a session event", () => {
    const s = run([{ type: "session", sessionId: "abc" }]);
    expect(s.sessionId).toBe("abc");
    expect(s.messages).toEqual([]);
  });

  it("appends result and error messages", () => {
    const s = run([
      { type: "result", result: "done", isError: false },
      { type: "error", message: "boom" },
    ]);
    expect(s.messages).toEqual([
      { kind: "result", text: "done" },
      { kind: "error", text: "boom" },
    ]);
  });

  it("extracts text and tool_use blocks from a raw assistant message", () => {
    const raw: AgentEvent = {
      type: "raw",
      message: {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", name: "Read", input: { file: "a.ts" } },
          ],
        },
      },
    };
    const s = run([raw]);
    expect(s.messages).toEqual([
      { kind: "text", text: "let me check" },
      { kind: "tool", text: "Read", toolName: "Read", toolInput: { file: "a.ts" } },
    ]);
  });

  it("ignores raw events it does not understand", () => {
    const s = run([{ type: "raw", message: { type: "system", subtype: "other" } }]);
    expect(s.messages).toEqual([]);
  });

  it("does not mutate the previous state", () => {
    const before = initialAgentState;
    const after = reduceAgent(before, { type: "result", result: "x", isError: false });
    expect(before.messages).toEqual([]);
    expect(after).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run test/agentEvents.test.ts`
Expected: FAIL — cannot resolve `../src/lib/agentEvents`.

- [ ] **Step 3: Write the implementation** — `client/src/lib/agentEvents.ts`

```typescript
import type { AgentEvent } from "./types";

export interface TranscriptMessage {
  kind: "text" | "result" | "error" | "tool";
  text: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface AgentState {
  sessionId: string | null;
  messages: TranscriptMessage[];
}

export const initialAgentState: AgentState = { sessionId: null, messages: [] };

function extractFromRaw(message: unknown): TranscriptMessage[] {
  if (typeof message !== "object" || message === null) return [];
  const m = message as Record<string, unknown>;
  if (m.type !== "assistant") return [];
  const inner = m.message as Record<string, unknown> | undefined;
  const content = inner?.content;
  if (!Array.isArray(content)) return [];
  const out: TranscriptMessage[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ kind: "text", text: b.text });
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      out.push({ kind: "tool", text: b.name, toolName: b.name, toolInput: b.input });
    }
  }
  return out;
}

export function reduceAgent(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case "session":
      return { ...state, sessionId: event.sessionId };
    case "result":
      return { ...state, messages: [...state.messages, { kind: "result", text: event.result }] };
    case "error":
      return { ...state, messages: [...state.messages, { kind: "error", text: event.message }] };
    case "raw": {
      const extracted = extractFromRaw(event.message);
      if (extracted.length === 0) return state;
      return { ...state, messages: [...state.messages, ...extracted] };
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run test/agentEvents.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/agentEvents.ts client/test/agentEvents.test.ts
git commit -m "feat(client): agent-event reducer building the transcript view model"
```

---

### Task 4: Registry store (`lib/registryStore.ts`)

**Files:**
- Create: `client/src/lib/registryStore.ts`
- Test: `client/test/registryStore.test.ts`

**Interfaces:**
- Consumes: `RegistrySnapshot` (Task 2).
- Produces:
  - `interface Tab { id: string; title: string; url: string }`
  - `reduceRegistry(snapshot: RegistrySnapshot): Tab[]` — the registry snapshot is the full ground truth, so this maps it straight to the tab list (no merge needed).

- [ ] **Step 1: Write the failing test** — `client/test/registryStore.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { reduceRegistry } from "../src/lib/registryStore";
import type { RegistrySnapshot } from "../src/lib/types";

const snap = (ids: string[]): RegistrySnapshot => ({
  surfaces: ids.map((id) => ({
    id,
    title: `T-${id}`,
    url: `/surfaces/${id}/`,
    kind: "file",
    created: "t",
    updated: "t",
  })),
});

describe("reduceRegistry", () => {
  it("maps a snapshot to tabs", () => {
    expect(reduceRegistry(snap(["a", "b"]))).toEqual([
      { id: "a", title: "T-a", url: "/surfaces/a/" },
      { id: "b", title: "T-b", url: "/surfaces/b/" },
    ]);
  });

  it("an empty snapshot yields no tabs", () => {
    expect(reduceRegistry(snap([]))).toEqual([]);
  });

  it("a later snapshot fully replaces the tab list", () => {
    const first = reduceRegistry(snap(["a", "b"]));
    const second = reduceRegistry(snap(["c"]));
    expect(first.map((t) => t.id)).toEqual(["a", "b"]);
    expect(second.map((t) => t.id)).toEqual(["c"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run test/registryStore.test.ts`
Expected: FAIL — cannot resolve `../src/lib/registryStore`.

- [ ] **Step 3: Write the implementation** — `client/src/lib/registryStore.ts`

```typescript
import type { RegistrySnapshot } from "./types";

export interface Tab {
  id: string;
  title: string;
  url: string;
}

export function reduceRegistry(snapshot: RegistrySnapshot): Tab[] {
  return snapshot.surfaces.map((s) => ({ id: s.id, title: s.title, url: s.url }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run test/registryStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/registryStore.ts client/test/registryStore.test.ts
git commit -m "feat(client): registry store mapping snapshots to canvas tabs"
```

---

### Task 5: Session tracking (`lib/session.ts`)

**Files:**
- Create: `client/src/lib/session.ts`
- Test: `client/test/session.test.ts`

**Interfaces:**
- Produces:
  - `interface TrackedSession { id: string; title: string; createdAt: string }`
  - `addSession(list: TrackedSession[], session: TrackedSession): TrackedSession[]` — prepends, deduping by `id` (existing id → list returned unchanged). Pure: `createdAt` is supplied by the caller (no `Date.now()` here).

- [ ] **Step 1: Write the failing test** — `client/test/session.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { addSession, type TrackedSession } from "../src/lib/session";

const s = (id: string): TrackedSession => ({ id, title: `first prompt ${id}`, createdAt: "2026-06-30T00:00:00Z" });

describe("addSession", () => {
  it("prepends a new session", () => {
    const list = addSession([s("a")], s("b"));
    expect(list.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("dedupes by id without reordering", () => {
    const before = [s("b"), s("a")];
    const after = addSession(before, s("b"));
    expect(after.map((x) => x.id)).toEqual(["b", "a"]);
    expect(after).toBe(before);
  });

  it("does not mutate the input list when prepending", () => {
    const before = [s("a")];
    const after = addSession(before, s("b"));
    expect(before.map((x) => x.id)).toEqual(["a"]);
    expect(after).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run test/session.test.ts`
Expected: FAIL — cannot resolve `../src/lib/session`.

- [ ] **Step 3: Write the implementation** — `client/src/lib/session.ts`

```typescript
export interface TrackedSession {
  id: string;
  title: string;
  createdAt: string;
}

export function addSession(
  list: TrackedSession[],
  session: TrackedSession,
): TrackedSession[] {
  if (list.some((x) => x.id === session.id)) return list;
  return [session, ...list];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run test/session.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full client suite + typecheck**

Run: `cd client && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all tests PASS; `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/session.ts client/test/session.test.ts
git commit -m "feat(client): local session tracking for the sidebar"
```

---

## Done criteria

- `cd agent-host && npx vitest run && npx tsc -p tsconfig.json --noEmit` — all pass (turn streaming added, nothing broken).
- `cd client && npm install && npx vitest run && npx tsc -p tsconfig.json --noEmit` — all pass.
- The agent host serves `GET /turns/:turnId/stream` and accepts `turnId` on `POST /messages`; the client foundation exposes `reduceAgent`, `reduceRegistry`, and `addSession`, each unit-tested.

## Next plan

**Plan 3b — Tauri shell + Rust proxy + React UI**: scaffold `client/src-tauri/` (Tauri v2), add the Rust SSE parser + proxy commands (`send_message`, `start_agent_stream`, `get_registry`, `start_registry_stream`, `open_surface_window`) and the event bridge, and build the React components (ConnectionScreen, AgentPanel, Canvas, Workspace) on top of this foundation. Grounded against live Tauri v2 docs; verified by running the app against the two hosts.
