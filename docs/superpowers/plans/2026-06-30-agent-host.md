# Agent Host Implementation Plan (Rhumb — Plan 1 of 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side **agent host** — an HTTP+SSE service that runs on the Proxmox box, wraps Claude Code via the Claude Agent SDK on the operator's own subscription, and exposes a small language-agnostic session API over the Tailscale network.

**Architecture:** A standalone Node/TypeScript process behind an HTTP/JSON + SSE contract (so any component can be reimplemented in another language later). One Express server exposes `POST /messages` (start or continue a session) and `GET /sessions/:id/stream` (SSE event stream). A `SessionManager` wraps the SDK's `query()` generator, normalizes its messages into a small `AgentEvent` union, and fans them out to SSE subscribers. The SDK call is dependency-injected so the manager is unit-testable without a live model.

**Tech Stack:** TypeScript (strict), Node ≥ 20, Express 4, `@anthropic-ai/claude-agent-sdk`, Vitest + Supertest. Auth via `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`).

## Global Constraints

- **Runtime:** Node ≥ 20, TypeScript `strict: true`, ES modules (`"type": "module"`).
- **Auth:** the process authenticates Claude with the operator's subscription via the `CLAUDE_CODE_OAUTH_TOKEN` environment variable. **Never** read or require `ANTHROPIC_API_KEY`. The host must refuse to start if `CLAUDE_CODE_OAUTH_TOKEN` is unset.
- **Model:** default `claude-opus-4-8`; overridable via the `RHUMB_MODEL` env var.
- **Workspace:** all agent work happens in the directory named by `RHUMB_WORKSPACE` (default `./workspace`); this is the file-as-contract folder later components watch.
- **Wire contract:** every event sent to clients is one of the `AgentEvent` union members defined in Task 2. Do not invent ad-hoc shapes elsewhere.
- **Compliance:** this is a self-hosted personal tool. Do not add any feature that brokers, proxies, or "offers" Claude login to a third party (see the spec §6 compliance note).
- **Compatibility note:** exact nesting of *assistant-message content* in the SDK is not relied on in v1 — only `system`/`init` (carries `session_id`), `result` messages, and a `raw` passthrough are normalized. Richer per-tool rendering is a later plan (the Tauri client).

---

### Task 1: Project scaffold + config module

**Files:**
- Create: `agent-host/package.json`
- Create: `agent-host/tsconfig.json`
- Create: `agent-host/vitest.config.ts`
- Create: `agent-host/src/config.ts`
- Test: `agent-host/test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` where
  `interface Config { port: number; model: string; workspace: string; oauthToken: string }`.
  Throws `Error` with a clear message if `CLAUDE_CODE_OAUTH_TOKEN` is missing/empty.

- [ ] **Step 1: Create `agent-host/package.json`**

```json
{
  "name": "rhumb-agent-host",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
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

- [ ] **Step 2: Create `agent-host/tsconfig.json`**

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

- [ ] **Step 3: Create `agent-host/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 4: Install dependencies**

Run: `cd agent-host && npm install`
Expected: completes with a `node_modules/` directory and no error exit code.

- [ ] **Step 5: Write the failing test** — `agent-host/test/config.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("throws when CLAUDE_CODE_OAUTH_TOKEN is missing", () => {
    expect(() => loadConfig({})).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("rejects an API key as a substitute for the subscription token", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "sk-ant-xxx" })).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });

  it("returns defaults when only the token is set", () => {
    const cfg = loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(cfg).toEqual({
      port: 8787,
      model: "claude-opus-4-8",
      workspace: "./workspace",
      oauthToken: "tok",
    });
  });

  it("honors overrides", () => {
    const cfg = loadConfig({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      RHUMB_PORT: "9000",
      RHUMB_MODEL: "claude-sonnet-4-6",
      RHUMB_WORKSPACE: "/srv/ws",
    });
    expect(cfg).toEqual({
      port: 9000,
      model: "claude-sonnet-4-6",
      workspace: "/srv/ws",
      oauthToken: "tok",
    });
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd agent-host && npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 7: Write the implementation** — `agent-host/src/config.ts`

```typescript
export interface Config {
  port: number;
  model: string;
  workspace: string;
  oauthToken: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!oauthToken) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN is required. Generate one with `claude setup-token` " +
        "(uses your Claude subscription). Rhumb does not use ANTHROPIC_API_KEY.",
    );
  }
  return {
    port: env.RHUMB_PORT ? Number(env.RHUMB_PORT) : 8787,
    model: env.RHUMB_MODEL?.trim() || "claude-opus-4-8",
    workspace: env.RHUMB_WORKSPACE?.trim() || "./workspace",
    oauthToken,
  };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd agent-host && npx vitest run test/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add agent-host/package.json agent-host/tsconfig.json agent-host/vitest.config.ts agent-host/src/config.ts agent-host/test/config.test.ts agent-host/package-lock.json
git commit -m "feat(agent-host): scaffold project and config loader"
```

---

### Task 2: Wire-contract types + SSE helper

**Files:**
- Create: `agent-host/src/types.ts`
- Create: `agent-host/src/sse.ts`
- Test: `agent-host/test/sse.test.ts`

**Interfaces:**
- Produces: the `AgentEvent` union (below) — the single event vocabulary every consumer reads.
- Produces: `writeSseEvent(res: { write(chunk: string): void }, event: AgentEvent): void` — serializes one event as an SSE `data:` frame terminated by a blank line.

- [ ] **Step 1: Write the types** — `agent-host/src/types.ts`

```typescript
export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "result"; result: string; isError: boolean }
  | { type: "error"; message: string }
  | { type: "raw"; message: unknown };
```

- [ ] **Step 2: Write the failing test** — `agent-host/test/sse.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { writeSseEvent } from "../src/sse.js";

describe("writeSseEvent", () => {
  it("serializes an event as a single-line JSON SSE frame", () => {
    const chunks: string[] = [];
    writeSseEvent({ write: (c) => chunks.push(c) }, {
      type: "session",
      sessionId: "abc",
    });
    expect(chunks.join("")).toBe(
      'data: {"type":"session","sessionId":"abc"}\n\n',
    );
  });

  it("escapes newlines inside payloads so frames stay single-line", () => {
    const chunks: string[] = [];
    writeSseEvent({ write: (c) => chunks.push(c) }, {
      type: "result",
      result: "line1\nline2",
      isError: false,
    });
    const out = chunks.join("");
    expect(out.endsWith("\n\n")).toBe(true);
    // exactly one data line (the JSON-encoded \n is the two chars backslash-n)
    expect(out.split("\n").filter((l) => l.startsWith("data: ")).length).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd agent-host && npx vitest run test/sse.test.ts`
Expected: FAIL — cannot resolve `../src/sse.js`.

- [ ] **Step 4: Write the implementation** — `agent-host/src/sse.ts`

```typescript
import type { AgentEvent } from "./types.js";

export function writeSseEvent(
  res: { write(chunk: string): void },
  event: AgentEvent,
): void {
  // JSON.stringify produces a single line (newlines become \n), keeping the
  // SSE frame to one `data:` line followed by the mandatory blank line.
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd agent-host && npx vitest run test/sse.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add agent-host/src/types.ts agent-host/src/sse.ts agent-host/test/sse.test.ts
git commit -m "feat(agent-host): define AgentEvent contract and SSE writer"
```

---

### Task 3: Session manager (core, SDK injected)

**Files:**
- Create: `agent-host/src/sessionManager.ts`
- Test: `agent-host/test/sessionManager.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` (Task 2).
- Produces:
  - `type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<any>` — the SDK's `query` signature, narrowed to what we use.
  - `class SessionManager` with:
    - `constructor(opts: { query: QueryFn; model: string; workspace: string })`
    - `run(prompt: string, sessionId: string | undefined, onEvent: (e: AgentEvent) => void): Promise<string>` — runs one turn; if `sessionId` is undefined a new session is created. Forwards normalized `AgentEvent`s to `onEvent` and resolves to the session id once known.

The manager maps SDK messages to events: a `system`/`init` message → `{type:"session"}`; a message with a `result` field → `{type:"result"}`; anything else → `{type:"raw"}`. Errors thrown by the generator → `{type:"error"}`.

- [ ] **Step 1: Write the failing test** — `agent-host/test/sessionManager.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { SessionManager, type QueryFn } from "../src/sessionManager.js";
import type { AgentEvent } from "../src/types.js";

// Fake SDK message stream: an init message, an opaque assistant message, a result.
function fakeQuery(messages: any[]): QueryFn {
  return () =>
    (async function* () {
      for (const m of messages) yield m;
    })();
}

describe("SessionManager.run", () => {
  it("emits session, raw, then result events and resolves with the session id", async () => {
    const query = fakeQuery([
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "result", result: "done", is_error: false },
    ]);
    const mgr = new SessionManager({ query, model: "m", workspace: "./ws" });

    const events: AgentEvent[] = [];
    const id = await mgr.run("hello", undefined, (e) => events.push(e));

    expect(id).toBe("sess-1");
    expect(events[0]).toEqual({ type: "session", sessionId: "sess-1" });
    expect(events[1]).toEqual({
      type: "raw",
      message: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    });
    expect(events[2]).toEqual({ type: "result", result: "done", isError: false });
  });

  it("passes resume + model + cwd into the query options", async () => {
    const calls: any[] = [];
    const query: QueryFn = (args) => {
      calls.push(args);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-2" };
        yield { type: "result", result: "", is_error: false };
      })();
    };
    const mgr = new SessionManager({ query, model: "claude-opus-4-8", workspace: "/ws" });
    await mgr.run("again", "sess-2", () => {});

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe("again");
    expect(calls[0].options.resume).toBe("sess-2");
    expect(calls[0].options.model).toBe("claude-opus-4-8");
    expect(calls[0].options.cwd).toBe("/ws");
  });

  it("emits an error event when the generator throws", async () => {
    const query: QueryFn = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-3" };
        throw new Error("boom");
      })();
    const mgr = new SessionManager({ query, model: "m", workspace: "./ws" });

    const events: AgentEvent[] = [];
    await mgr.run("x", undefined, (e) => events.push(e));

    expect(events.at(-1)).toEqual({ type: "error", message: "boom" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd agent-host && npx vitest run test/sessionManager.test.ts`
Expected: FAIL — cannot resolve `../src/sessionManager.js`.

- [ ] **Step 3: Write the implementation** — `agent-host/src/sessionManager.ts`

```typescript
import type { AgentEvent } from "./types.js";

export type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<any>;

export class SessionManager {
  private readonly query: QueryFn;
  private readonly model: string;
  private readonly workspace: string;

  constructor(opts: { query: QueryFn; model: string; workspace: string }) {
    this.query = opts.query;
    this.model = opts.model;
    this.workspace = opts.workspace;
  }

  async run(
    prompt: string,
    sessionId: string | undefined,
    onEvent: (e: AgentEvent) => void,
  ): Promise<string> {
    const options: Record<string, unknown> = {
      model: this.model,
      cwd: this.workspace,
      permissionMode: "acceptEdits",
    };
    if (sessionId) options.resume = sessionId;

    let resolvedId = sessionId ?? "";
    try {
      for await (const message of this.query({ prompt, options })) {
        if (message?.type === "system" && message?.subtype === "init") {
          resolvedId = message.session_id;
          onEvent({ type: "session", sessionId: resolvedId });
        } else if (message && "result" in message) {
          onEvent({
            type: "result",
            result: String(message.result ?? ""),
            isError: Boolean(message.is_error),
          });
        } else {
          onEvent({ type: "raw", message });
        }
      }
    } catch (err) {
      onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return resolvedId;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd agent-host && npx vitest run test/sessionManager.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/sessionManager.ts agent-host/test/sessionManager.test.ts
git commit -m "feat(agent-host): SessionManager wrapping the Agent SDK query loop"
```

---

### Task 4: HTTP server (routes + SSE fan-out)

**Files:**
- Create: `agent-host/src/server.ts`
- Test: `agent-host/test/server.test.ts`

**Interfaces:**
- Consumes: `SessionManager` (Task 3), `writeSseEvent` (Task 2), `AgentEvent` (Task 2).
- Produces: `createServer(deps: { manager: Pick<SessionManager, "run"> }): import("express").Express` exposing:
  - `POST /messages` — body `{ sessionId?: string; prompt: string }`. Starts a turn in the background, returns `202 { sessionId }` where `sessionId` is the input id or `""` (new sessions resolve their id on the SSE stream). 400 if `prompt` is missing.
  - `GET /sessions/:id/stream` — SSE stream of that session's `AgentEvent`s. (For v1 the stream is per-turn: a turn is started by `POST /messages` and its events are pushed to currently-connected subscribers of that session id.)
  - `GET /healthz` — `200 { ok: true }`.

The server keeps an in-memory `Map<string, Set<res>>` of SSE subscribers keyed by session id, plus a `"pending"` bucket for new sessions whose id is not yet known; when a turn emits its first `session` event, pending subscribers are rekeyed to that id.

- [ ] **Step 1: Write the failing test** — `agent-host/test/server.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "../src/server.js";
import type { AgentEvent } from "../src/types.js";

function fakeManager(script: AgentEvent[]) {
  return {
    async run(
      _prompt: string,
      sessionId: string | undefined,
      onEvent: (e: AgentEvent) => void,
    ) {
      for (const e of script) onEvent(e);
      return sessionId ?? "sess-x";
    },
  };
}

describe("agent-host server", () => {
  it("GET /healthz returns ok", async () => {
    const app = createServer({ manager: fakeManager([]) });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("POST /messages without a prompt is a 400", async () => {
    const app = createServer({ manager: fakeManager([]) });
    const res = await request(app).post("/messages").send({});
    expect(res.status).toBe(400);
  });

  it("POST /messages with a prompt returns 202 and an echoed sessionId", async () => {
    const app = createServer({ manager: fakeManager([{ type: "result", result: "ok", isError: false }]) });
    const res = await request(app)
      .post("/messages")
      .send({ sessionId: "sess-9", prompt: "hi" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sessionId: "sess-9" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd agent-host && npx vitest run test/server.test.ts`
Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 3: Write the implementation** — `agent-host/src/server.ts`

```typescript
import express, { type Express, type Response } from "express";
import type { AgentEvent } from "./types.js";
import { writeSseEvent } from "./sse.js";

interface ManagerLike {
  run(
    prompt: string,
    sessionId: string | undefined,
    onEvent: (e: AgentEvent) => void,
  ): Promise<string>;
}

export function createServer(deps: { manager: ManagerLike }): Express {
  const app = express();
  app.use(express.json());

  // session id -> set of open SSE responses. "" is the pending bucket for
  // turns that started a brand-new session whose id is not known yet.
  const subscribers = new Map<string, Set<Response>>();
  const subsFor = (id: string) => {
    let set = subscribers.get(id);
    if (!set) {
      set = new Set();
      subscribers.set(id, set);
    }
    return set;
  };

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/sessions/:id/stream", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    const id = req.params.id;
    const set = subsFor(id);
    set.add(res);
    req.on("close", () => set.delete(res));
  });

  app.post("/messages", (req, res) => {
    const { sessionId, prompt } = req.body ?? {};
    if (typeof prompt !== "string" || prompt.length === 0) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    const inputId: string | undefined =
      typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;

    // Subscribers connect against the input id when known, else the pending "" bucket.
    let targetId = inputId ?? "";

    const onEvent = (e: AgentEvent) => {
      if (e.type === "session" && e.sessionId && e.sessionId !== targetId) {
        // Rekey pending subscribers to the freshly-minted session id.
        const pending = subscribers.get(targetId);
        if (pending) {
          const dest = subsFor(e.sessionId);
          for (const r of pending) dest.add(r);
          if (targetId === "") subscribers.delete("");
        }
        targetId = e.sessionId;
      }
      for (const r of subscribers.get(targetId) ?? []) writeSseEvent(r, e);
    };

    // Fire the turn in the background; clients read results via the SSE stream.
    void deps.manager.run(prompt, inputId, onEvent);

    res.status(202).json({ sessionId: inputId ?? "" });
  });

  return app;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd agent-host && npx vitest run test/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/server.ts agent-host/test/server.test.ts
git commit -m "feat(agent-host): HTTP routes with SSE fan-out per session"
```

---

### Task 5: Entrypoint, real SDK wiring, README + compliance note

**Files:**
- Create: `agent-host/src/index.ts`
- Create: `agent-host/README.md`
- Create: `agent-host/.gitignore`
- Test: `agent-host/test/index.smoke.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `SessionManager` (Task 3), `createServer` (Task 4), and the SDK's `query`.
- Produces: a runnable process (`node dist/index.js`) that binds the config, sets `process.env.CLAUDE_CODE_OAUTH_TOKEN` for the SDK, and listens on the configured port.

- [ ] **Step 1: Write the failing smoke test** — `agent-host/test/index.smoke.test.ts`

This test verifies the wiring factory builds a server end-to-end with an injected fake `query`, without binding a port or calling the real model.

```typescript
import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../src/index.js";

describe("buildApp wiring", () => {
  it("builds an app whose /messages drives the injected query and streams a result", async () => {
    const app = buildApp({
      config: { port: 0, model: "m", workspace: "./ws", oauthToken: "tok" },
      query: () =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "sess-7" };
          yield { type: "result", result: "hello world", is_error: false };
        })(),
    });

    const health = await request(app).get("/healthz");
    expect(health.status).toBe(200);

    const posted = await request(app).post("/messages").send({ prompt: "hi" });
    expect(posted.status).toBe(202);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd agent-host && npx vitest run test/index.smoke.test.ts`
Expected: FAIL — cannot resolve `../src/index.js` (or `buildApp` is not exported).

- [ ] **Step 3: Write the implementation** — `agent-host/src/index.ts`

```typescript
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, type Config } from "./config.js";
import { SessionManager, type QueryFn } from "./sessionManager.js";
import { createServer } from "./server.js";
import type { Express } from "express";

export function buildApp(deps: { config: Config; query: QueryFn }): Express {
  const manager = new SessionManager({
    query: deps.query,
    model: deps.config.model,
    workspace: deps.config.workspace,
  });
  return createServer({ manager });
}

// Wrap the SDK's query so it matches our narrowed QueryFn signature.
const realQuery: QueryFn = (args) => sdkQuery(args as never);

export function main(): void {
  const config = loadConfig(process.env);
  // The SDK reads CLAUDE_CODE_OAUTH_TOKEN from the environment; it is already
  // present (loadConfig requires it), so no extra wiring is needed here.
  const app = buildApp({ config, query: realQuery });
  app.listen(config.port, () => {
    console.log(`rhumb agent-host listening on :${config.port} (model ${config.model})`);
  });
}

// Run only when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd agent-host && npx vitest run test/index.smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `cd agent-host && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all tests PASS; `tsc` reports no errors.

- [ ] **Step 6: Create `agent-host/.gitignore`**

```
node_modules/
dist/
workspace/
```

- [ ] **Step 7: Create `agent-host/README.md`**

```markdown
# Rhumb Agent Host

Server-side component of Rhumb. Wraps Claude Code (via the Claude Agent SDK) and
exposes a small HTTP + SSE session API over your Tailscale network.

## Authentication — personal-tool framing

Rhumb authenticates Claude with **your own Claude subscription**, not an API key.
Generate a long-lived token once:

    claude setup-token

Then export it before starting the host:

    export CLAUDE_CODE_OAUTH_TOKEN=...   # from `claude setup-token`

> **Compliance note.** Anthropic's terms state that, without prior approval,
> third-party developers may not *offer* claude.ai login or rate limits in their
> products — including agents built on the Claude Agent SDK. Rhumb is a
> **self-hosted personal tool**: you run it on your own hardware with your own
> credentials. It does not broker, proxy, or offer Claude login to anyone else.
> If you want to distribute a multi-tenant or hosted offering, seek Anthropic's
> approval first.

## Run

    npm install
    npm run build
    CLAUDE_CODE_OAUTH_TOKEN=... npm start

Environment variables: `CLAUDE_CODE_OAUTH_TOKEN` (required), `RHUMB_PORT`
(default 8787), `RHUMB_MODEL` (default `claude-opus-4-8`), `RHUMB_WORKSPACE`
(default `./workspace`).

## API

- `POST /messages` — `{ "sessionId"?: string, "prompt": string }` → `202 { sessionId }`.
- `GET /sessions/:id/stream` — Server-Sent Events; each frame is one `AgentEvent`
  (`session` | `result` | `error` | `raw`).
- `GET /healthz` — `{ ok: true }`.
```

- [ ] **Step 8: Commit**

```bash
git add agent-host/src/index.ts agent-host/README.md agent-host/.gitignore agent-host/test/index.smoke.test.ts
git commit -m "feat(agent-host): entrypoint, SDK wiring, README with compliance note"
```

---

## Done criteria

- `cd agent-host && npm install && npx vitest run && npx tsc -p tsconfig.json --noEmit` all succeed.
- With a real `CLAUDE_CODE_OAUTH_TOKEN`, `npm run build && npm start` boots and `GET /healthz` returns `{ ok: true }` over the tailnet.
- A `POST /messages` followed by an open `GET /sessions/:id/stream` yields a `session` event then a `result` event end-to-end (manual check against the live model).

## Next plan

**Plan 2 — Dashboard host + registry**: watch `RHUMB_WORKSPACE`, serve `file` surfaces at stable tailnet URLs, expose the registry. It shares the workspace directory contract established here.
