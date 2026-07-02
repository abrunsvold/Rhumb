# Platform Shell + First-Class Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Frame the client in an icon-rail navigation shell and make sessions durable, named, parallel first-class objects: host-side index + transcript service, Rust proxy commands, sessions panel, and multiple live chat tabs.

**Architecture:** agent-host grows a `sessions.ts` service (persisted index at `<workspace>/sessions.json`, transcript parsing from the Claude SDK's stored JSONL) exposed as guarded routes and fed by the existing `/messages` event hook. The Rust proxy adds six commands following the pinned-host bearer pattern. The client lifts chat state out of `AgentPanel` into a keyed store + `useChatSessions` hook (one `AgentState` per open session, one live session stream each), and the layout becomes rail → collapsible panel → main (chat tabs + canvas).

**Tech Stack:** Node/Express/TypeScript (agent-host), Tauri 2 / Rust (proxy), React 18 + Tailwind v4 tokens (client), vitest + supertest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-02-shell-sessions-design.md`
**Branch:** `feat/shell-sessions` (off main; already created, spec committed).

## Global Constraints

- All new agent-host routes sit behind the existing control-token guard (mounted before routes in `createServer`); body parsers stay AFTER the guard.
- Session ids from URLs are validated against `/^[A-Za-z0-9-]{1,64}$/` before any filesystem use (they name files under the SDK projects dir).
- Index writes are atomic: write `<path>.tmp` then `renameSync`.
- Auto-title/preview = first prompt truncated to 60 chars at a word boundary with `…` appended when truncated.
- Client styling uses only the Tailwind tokens (`bg`, `panel`, `raised`, `line`, `ink`, `muted`, `accent`, `accent-soft`, `danger`); no inline styles; no new client runtime dependencies.
- Keep existing accessible roles/labels working: chat textbox + "Send", `role="alert"`, `role="dialog"`, canvas `role="tab"`/`tablist`. New: rail buttons carry `aria-label` ("Sessions", "Surfaces", "Connection"); session tabs use `role="tab"` inside a `role="tablist"` labeled "Open sessions".
- Existing suites must keep passing: `cd agent-host && npm test`, `cd client && npm test && npm run typecheck`, `cd client/src-tauri && cargo test`.
- Transcript parsing skips records with `isSidechain: true`, unknown record types, and `tool_result` blocks.
- Repo root: all paths relative to it. Client commands run in `client/`, host in `agent-host/`, Rust in `client/src-tauri/`.

---

### Task 1: agent-host — session index service

**Files:**
- Create: `agent-host/src/sessions.ts`
- Test: `agent-host/test/sessions.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, deps injected).
- Produces (Tasks 2–3 rely on these exact signatures):

```ts
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  preview: string;
  archived: boolean;
}
export interface SessionService {
  upsertFromTurn(id: string, prompt: string): void;
  list(includeArchived?: boolean): SessionMeta[];
  rename(id: string, title: string): boolean;   // false = unknown id
  archive(id: string): boolean;
  readTranscript(id: string): TranscriptMessage[] | null; // Task 2
}
export function createSessionService(deps: {
  indexPath: string;      // <workspace>/sessions.json
  projectsDir: string;    // SDK projects dir (Task 2)
  workspace: string;      // absolute or relative; resolved internally
  now: () => string;      // ISO timestamp
}): SessionService;
export function truncateTitle(prompt: string): string; // 60-char word-boundary + …
```

- [ ] **Step 1: Write the failing tests**

Create `agent-host/test/sessions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionService, truncateTitle } from "../src/sessions.js";

function service(nowRef = { t: "2026-07-02T00:00:00Z" }) {
  const dir = mkdtempSync(join(tmpdir(), "rhumb-sess-"));
  const svc = createSessionService({
    indexPath: join(dir, "sessions.json"),
    projectsDir: join(dir, "projects"),
    workspace: join(dir, "ws"),
    now: () => nowRef.t,
  });
  return { svc, dir, nowRef };
}

describe("truncateTitle", () => {
  it("passes short prompts through", () => {
    expect(truncateTitle("fix the header")).toBe("fix the header");
  });
  it("truncates at a word boundary under 60 chars and appends an ellipsis", () => {
    const long = "analyze the printer telemetry table and produce a weekly summary of anomalies";
    const t = truncateTitle(long);
    expect(t.length).toBeLessThanOrEqual(61); // 60 + ellipsis char
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toMatch(/\s…$/); // no dangling space before ellipsis
  });
  it("collapses newlines to spaces", () => {
    expect(truncateTitle("line one\nline two")).toBe("line one line two");
  });
});

describe("session index", () => {
  it("creates a session on first upsert with title=preview=truncated prompt", () => {
    const { svc } = service();
    svc.upsertFromTurn("s1", "hello there");
    const [s] = svc.list();
    expect(s).toEqual({
      id: "s1",
      title: "hello there",
      createdAt: "2026-07-02T00:00:00Z",
      lastActiveAt: "2026-07-02T00:00:00Z",
      preview: "hello there",
      archived: false,
    });
  });

  it("bumps lastActiveAt (not title/createdAt) on later turns and sorts newest first", () => {
    const { svc, nowRef } = service();
    svc.upsertFromTurn("s1", "first session");
    nowRef.t = "2026-07-02T01:00:00Z";
    svc.upsertFromTurn("s2", "second session");
    nowRef.t = "2026-07-02T02:00:00Z";
    svc.upsertFromTurn("s1", "a much later prompt");
    const list = svc.list();
    expect(list.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(list[0].title).toBe("first session");
    expect(list[0].createdAt).toBe("2026-07-02T00:00:00Z");
    expect(list[0].lastActiveAt).toBe("2026-07-02T02:00:00Z");
  });

  it("persists atomically and reloads from disk", () => {
    const { svc, dir } = service();
    svc.upsertFromTurn("s1", "persist me");
    expect(existsSync(join(dir, "sessions.json"))).toBe(true);
    expect(existsSync(join(dir, "sessions.json.tmp"))).toBe(false);
    const raw = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
    expect(raw[0].id).toBe("s1");
    // a fresh service over the same file sees the data
    const svc2 = createSessionService({
      indexPath: join(dir, "sessions.json"),
      projectsDir: join(dir, "projects"),
      workspace: join(dir, "ws"),
      now: () => "2026-07-02T09:00:00Z",
    });
    expect(svc2.list()[0].id).toBe("s1");
  });

  it("rename validates and archive hides from the default list", () => {
    const { svc } = service();
    svc.upsertFromTurn("s1", "one");
    svc.upsertFromTurn("s2", "two");
    expect(svc.rename("s1", "Better name")).toBe(true);
    expect(svc.rename("missing", "x")).toBe(false);
    expect(svc.list().find((s) => s.id === "s1")?.title).toBe("Better name");
    expect(svc.archive("s2")).toBe(true);
    expect(svc.list().map((s) => s.id)).toEqual(["s1"]);
    expect(svc.list(true).map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("survives a corrupt index file by starting empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "rhumb-sess-"));
    const indexPath = join(dir, "sessions.json");
    require("node:fs").writeFileSync(indexPath, "{not json");
    const svc = createSessionService({
      indexPath,
      projectsDir: join(dir, "p"),
      workspace: join(dir, "w"),
      now: () => "2026-07-02T00:00:00Z",
    });
    expect(svc.list()).toEqual([]);
  });
});
```

(If `require` is unavailable under ESM vitest config, import `writeFileSync` at the top instead.)

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/sessions.test.ts`
Expected: FAIL — module `../src/sessions.js` does not exist.

- [ ] **Step 3: Implement**

Create `agent-host/src/sessions.ts`:

```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { TranscriptMessage } from "./types.js";

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  preview: string;
  archived: boolean;
}

export interface SessionService {
  upsertFromTurn(id: string, prompt: string): void;
  list(includeArchived?: boolean): SessionMeta[];
  rename(id: string, title: string): boolean;
  archive(id: string): boolean;
  readTranscript(id: string): TranscriptMessage[] | null;
}

const TITLE_MAX = 60;

export function truncateTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (flat.length <= TITLE_MAX) return flat;
  const cut = flat.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

function load(indexPath: string): SessionMeta[] {
  try {
    const raw = JSON.parse(readFileSync(indexPath, "utf8"));
    return Array.isArray(raw) ? (raw as SessionMeta[]) : [];
  } catch {
    return [];
  }
}

function save(indexPath: string, sessions: SessionMeta[]): void {
  mkdirSync(dirname(indexPath), { recursive: true });
  const tmp = `${indexPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  renameSync(tmp, indexPath);
}

export function createSessionService(deps: {
  indexPath: string;
  projectsDir: string;
  workspace: string;
  now: () => string;
}): SessionService {
  let sessions = load(deps.indexPath);

  const persist = () => save(deps.indexPath, sessions);

  return {
    upsertFromTurn(id, prompt) {
      const existing = sessions.find((s) => s.id === id);
      if (existing) {
        existing.lastActiveAt = deps.now();
      } else {
        const title = truncateTitle(prompt);
        sessions.push({
          id,
          title,
          createdAt: deps.now(),
          lastActiveAt: deps.now(),
          preview: title,
          archived: false,
        });
      }
      persist();
    },
    list(includeArchived = false) {
      return sessions
        .filter((s) => includeArchived || !s.archived)
        .slice()
        .sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1));
    },
    rename(id, title) {
      const s = sessions.find((x) => x.id === id);
      if (!s) return false;
      s.title = title;
      persist();
      return true;
    },
    archive(id) {
      const s = sessions.find((x) => x.id === id);
      if (!s) return false;
      s.archived = true;
      persist();
      return true;
    },
    readTranscript() {
      return null; // implemented in the transcript task
    },
  };
}
```

Note: `TranscriptMessage` does not exist in agent-host yet — Task 2 adds it to `agent-host/src/types.ts`. For this task, add the minimal type now so the interface compiles:

In `agent-host/src/types.ts`, append:

```ts
export interface TranscriptMessage {
  kind: "text" | "result" | "error" | "tool" | "user";
  text: string;
  toolName?: string;
  toolInput?: unknown;
}
```

- [ ] **Step 4: Run tests**

Run: `cd agent-host && npx vitest run test/sessions.test.ts` → PASS, then `npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/sessions.ts agent-host/src/types.ts agent-host/test/sessions.test.ts
git commit -m "feat(agent-host): persisted session index service"
```

---

### Task 2: agent-host — transcript reader

**Files:**
- Modify: `agent-host/src/sessions.ts` (fill in `readTranscript`, add helpers)
- Test: `agent-host/test/sessions.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's service shape.
- Produces: `readTranscript(id) → TranscriptMessage[] | null`; exported helper `encodeProjectDir(cwd: string): string` (path with every `/` and `.` replaced by `-`); session file resolved as `<projectsDir>/<encodeProjectDir(resolve(workspace))>/<id>.jsonl`.

Ground truth (sampled from a real host on 2026-07-02): records are JSONL lines like
`{"type":"user","isSidechain":false,"sessionId":"…","message":{"role":"user","content":[{"type":"text","text":"…"}]}}` and
`{"type":"assistant","isSidechain":false,"message":{"role":"assistant","content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"toolu_…","name":"Read","input":{"file_path":"…"}}]}}`,
plus non-message types (`queue-operation`, …) and occasionally `content` as a plain string. `user` records may contain `tool_result` blocks — skip those blocks. Skip any record with `isSidechain: true`.

- [ ] **Step 1: Write the failing tests**

Append to `agent-host/test/sessions.test.ts`:

```ts
import { mkdirSync as mkdirSyncFs, writeFileSync as writeFileSyncFs } from "node:fs";
import { resolve } from "node:path";
import { encodeProjectDir } from "../src/sessions.js";

describe("transcript reader", () => {
  it("encodes the project dir like the SDK (slashes and dots become dashes)", () => {
    expect(encodeProjectDir("/srv/rhumb-workspace")).toBe("-srv-rhumb-workspace");
    expect(encodeProjectDir("/Users/x/My.App")).toBe("-Users-x-My-App");
  });

  function withTranscript(lines: unknown[]) {
    const { svc, dir } = service();
    const ws = resolve(join(dir, "ws"));
    const sessDir = join(dir, "projects", encodeProjectDir(ws));
    mkdirSyncFs(sessDir, { recursive: true });
    writeFileSyncFs(
      join(sessDir, "abc-123.jsonl"),
      lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"),
    );
    return svc;
  }

  it("parses user text, assistant text, and tool_use into TranscriptMessages", () => {
    const svc = withTranscript([
      { type: "user", isSidechain: false, message: { role: "user", content: [{ type: "text", text: "read the file" }] } },
      { type: "assistant", isSidechain: false, message: { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "x.txt" } },
        { type: "text", text: "done" },
      ] } },
    ]);
    expect(svc.readTranscript("abc-123")).toEqual([
      { kind: "user", text: "read the file" },
      { kind: "tool", text: "Read", toolName: "Read", toolInput: { file_path: "x.txt" } },
      { kind: "text", text: "done" },
    ]);
  });

  it("skips sidechains, unknown types, tool_result blocks, string content on unknown roles, and garbage lines", () => {
    const svc = withTranscript([
      { type: "queue-operation", operation: "enqueue" },
      { type: "user", isSidechain: true, message: { role: "user", content: [{ type: "text", text: "hidden" }] } },
      { type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] } },
      "{not json",
      { type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "visible" }] } },
    ]);
    expect(svc.readTranscript("abc-123")).toEqual([{ kind: "text", text: "visible" }]);
  });

  it("handles plain-string user content", () => {
    const svc = withTranscript([
      { type: "user", isSidechain: false, message: { role: "user", content: "just a string" } },
    ]);
    expect(svc.readTranscript("abc-123")).toEqual([{ kind: "user", text: "just a string" }]);
  });

  it("returns null for a missing session file", () => {
    const { svc } = service();
    expect(svc.readTranscript("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/sessions.test.ts`
Expected: FAIL — `encodeProjectDir` not exported; `readTranscript` returns null for existing files.

- [ ] **Step 3: Implement**

In `agent-host/src/sessions.ts`, add imports `resolve`, `join` from `node:path`, and:

```ts
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

function blockToMessages(record: Record<string, unknown>): TranscriptMessage[] {
  const type = record.type;
  if ((type !== "user" && type !== "assistant") || record.isSidechain === true) return [];
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  const out: TranscriptMessage[] = [];
  if (typeof content === "string") {
    if (type === "user" && content.length > 0) out.push({ kind: "user", text: content });
    if (type === "assistant" && content.length > 0) out.push({ kind: "text", text: content });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      out.push({ kind: type === "user" ? "user" : "text", text: b.text });
    } else if (type === "assistant" && b.type === "tool_use" && typeof b.name === "string") {
      out.push({ kind: "tool", text: b.name, toolName: b.name, toolInput: b.input });
    }
    // tool_result and anything else: skipped
  }
  return out;
}
```

and replace the `readTranscript` stub in the returned service object:

```ts
    readTranscript(id) {
      const file = join(
        deps.projectsDir,
        encodeProjectDir(resolve(deps.workspace)),
        `${id}.jsonl`,
      );
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        return null;
      }
      const messages: TranscriptMessage[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          messages.push(...blockToMessages(JSON.parse(line)));
        } catch {
          // corrupt line: skip
        }
      }
      return messages;
    },
```

- [ ] **Step 4: Run tests**

Run: `cd agent-host && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/sessions.ts agent-host/test/sessions.test.ts
git commit -m "feat(agent-host): parse stored SDK transcripts into client message shapes"
```

---

### Task 3: agent-host — session routes + upsert wiring

**Files:**
- Modify: `agent-host/src/server.ts` (deps + routes + upsert hook), `agent-host/src/index.ts` (construct service)
- Test: `agent-host/test/server.test.ts` (extend)

**Interfaces:**
- Consumes: `SessionService` from Task 1/2.
- Produces (Task 4's Rust commands call these):
  - `GET /sessions` → `{ sessions: SessionMeta[] }` (`?archived=1` includes archived)
  - `GET /sessions/:id/transcript` → `{ messages: TranscriptMessage[] }` | 404 `{ error }`
  - `PATCH /sessions/:id` body `{ title }` (1–120 chars) → 204 | 400 | 404
  - `POST /sessions/:id/archive` → 204 | 404
  - All behind the guard; `:id` validated by `/^[A-Za-z0-9-]{1,64}$/` → 400 otherwise.
  - `createServer` deps gain `sessions?: SessionService`; when present, the `/messages` handler calls `sessions.upsertFromTurn(sessionId, prompt)` on every `session` event.

- [ ] **Step 1: Write the failing tests**

Append to `agent-host/test/server.test.ts` (reuse `request`, `createServer`, `fakeManager`):

```ts
import { createSessionService } from "../src/sessions.js";

function appWithSessions(script: AgentEvent[] = [{ type: "session", sessionId: "s-1" }]) {
  const dir = mkdtempSync(join(tmpdir(), "rhumb-sessapp-"));
  const sessions = createSessionService({
    indexPath: join(dir, "sessions.json"),
    projectsDir: join(dir, "projects"),
    workspace: join(dir, "ws"),
    now: () => "2026-07-02T00:00:00Z",
  });
  const app = createServer({ manager: fakeManager(script), sessions });
  return { app, sessions };
}

describe("session routes", () => {
  it("indexes a session when a turn emits a session event", async () => {
    const { app } = appWithSessions();
    await request(app).post("/messages").send({ prompt: "hello world" });
    const res = await request(app).get("/sessions");
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0]).toMatchObject({ id: "s-1", title: "hello world" });
  });

  it("rename and archive round-trip through the routes", async () => {
    const { app } = appWithSessions();
    await request(app).post("/messages").send({ prompt: "hi" });
    expect((await request(app).patch("/sessions/s-1").send({ title: "Renamed" })).status).toBe(204);
    expect((await request(app).post("/sessions/s-1/archive")).status).toBe(204);
    const dflt = await request(app).get("/sessions");
    expect(dflt.body.sessions).toHaveLength(0);
    const all = await request(app).get("/sessions?archived=1");
    expect(all.body.sessions[0]).toMatchObject({ id: "s-1", title: "Renamed", archived: true });
  });

  it("validates ids and titles", async () => {
    const { app } = appWithSessions();
    expect((await request(app).get("/sessions/..%2Fetc/transcript")).status).toBe(400);
    expect((await request(app).patch("/sessions/s-1").send({ title: "" })).status).toBe(400);
    expect((await request(app).patch("/sessions/unknown").send({ title: "x" })).status).toBe(404);
    expect((await request(app).post("/sessions/unknown/archive")).status).toBe(404);
  });

  it("transcript 404s when the session file is missing", async () => {
    const { app } = appWithSessions();
    await request(app).post("/messages").send({ prompt: "hi" });
    expect((await request(app).get("/sessions/s-1/transcript")).status).toBe(404);
  });

  it("session routes require the control token when configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rhumb-sessauth-"));
    const sessions = createSessionService({
      indexPath: join(dir, "sessions.json"), projectsDir: join(dir, "p"),
      workspace: join(dir, "w"), now: () => "2026-07-02T00:00:00Z",
    });
    const app = createServer({ manager: fakeManager([]), sessions, controlToken: "sekrit" });
    expect((await request(app).get("/sessions")).status).toBe(401);
    expect((await request(app).get("/sessions").set("Authorization", "Bearer sekrit")).status).toBe(200);
  });

  it("routes are absent when no session service is configured", async () => {
    const app = createServer({ manager: fakeManager([]) });
    expect((await request(app).get("/sessions")).status).toBe(404);
  });
});
```

(A full transcript-content route test is covered by the service tests in Task 2; here we cover wiring + statuses.)

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/server.test.ts`
Expected: new tests FAIL (404s on `/sessions`, TS error for the `sessions` dep).

- [ ] **Step 3: Implement**

In `agent-host/src/server.ts`:

- Import: `import type { SessionService } from "./sessions.js";`
- Deps type gains `sessions?: SessionService;`
- In the `/messages` handler's `onEvent`, right after the session-rebucketing block (inside the `if (e.type === "session" ...)` branch, using the request's `prompt`):

```ts
      if (e.type === "session" && e.sessionId) {
        deps.sessions?.upsertFromTurn(e.sessionId, prompt);
      }
```

(Place it so it runs once per session event; `prompt` is already in scope in the handler.)

- After the `/files` block, add:

```ts
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

if (deps.sessions) {
  const sessions = deps.sessions;

  app.get("/sessions", (req: Request, res: Response) => {
    res.json({ sessions: sessions.list(req.query.archived === "1") });
  });

  app.get("/sessions/:id/transcript", (req: Request, res: Response) => {
    const id = req.params.id;
    if (!SESSION_ID_RE.test(id)) {
      res.status(400).json({ error: "invalid session id" });
      return;
    }
    const messages = sessions.readTranscript(id);
    if (messages === null) {
      res.status(404).json({ error: "transcript not found" });
      return;
    }
    res.json({ messages });
  });

  app.patch("/sessions/:id", (req: Request, res: Response) => {
    const id = req.params.id;
    const title = (req.body ?? {}).title;
    if (!SESSION_ID_RE.test(id) || typeof title !== "string" || title.length < 1 || title.length > 120) {
      res.status(400).json({ error: "invalid id or title" });
      return;
    }
    res.status(sessions.rename(id, title) ? 204 : 404).end();
  });

  app.post("/sessions/:id/archive", (req: Request, res: Response) => {
    const id = req.params.id;
    if (!SESSION_ID_RE.test(id)) {
      res.status(400).json({ error: "invalid session id" });
      return;
    }
    res.status(sessions.archive(id) ? 204 : 404).end();
  });
}
```

In `agent-host/src/index.ts`, construct and pass the service where `createServer` is called:

```ts
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { createSessionService } from "./sessions.js";
// ...
  const sessions = createSessionService({
    indexPath: joinPath(deps.config.workspace, "sessions.json"),
    projectsDir: joinPath(homedir(), ".claude", "projects"),
    workspace: resolvePath(deps.config.workspace),
    now: () => new Date().toISOString(),
  });
  const app = createServer({
    manager,
    controlToken: deps.config.controlToken,
    workspace: deps.config.workspace,
    sessions,
  });
```

(Adapt import names to avoid clashing with existing `join`/`resolve` imports if present.)

- [ ] **Step 4: Run tests**

Run: `cd agent-host && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/server.ts agent-host/src/index.ts agent-host/test/server.test.ts
git commit -m "feat(agent-host): session list/transcript/rename/archive routes"
```

---

### Task 4: Rust proxy — session commands + session streams; TS wrappers

**Files:**
- Modify: `client/src-tauri/src/proxy.rs`, `client/src-tauri/src/lib.rs`, `client/src/lib/tauri.ts`, `client/src/lib/types.ts`

**Interfaces:**
- Consumes: Task 3's routes; existing `agent_target`, `pump`, `StreamState`.
- Produces (client Tasks 5–9 call these):

```ts
// client/src/lib/types.ts
export interface SessionMeta {
  id: string; title: string; createdAt: string;
  lastActiveAt: string; preview: string; archived: boolean;
}
// client/src/lib/tauri.ts
listSessions(agentBase: string): Promise<SessionMeta[]>
getTranscript(agentBase: string, sessionId: string): Promise<TranscriptMessage[]>
renameSession(agentBase: string, sessionId: string, title: string): Promise<void>
archiveSession(agentBase: string, sessionId: string): Promise<void>
openSessionStream(agentBase: string, sessionId: string, onEvent: (e: unknown) => void): () => void
```

`openSessionStream` delivers raw JSON values; when the underlying HTTP stream ends for any reason, the Rust side sends a final sentinel value `{"type":"stream_closed"}` so the client can schedule a retry.

- [ ] **Step 1: Rust — session JSON commands**

Append to `client/src-tauri/src/proxy.rs`:

```rust
#[tauri::command]
pub async fn list_sessions(app: tauri::AppHandle, agent_base: String) -> Result<Value, String> {
    let (url, bearer) = agent_target(&app, &agent_base, "/sessions")?;
    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if let Some(t) = &bearer {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_transcript(
    app: tauri::AppHandle,
    agent_base: String,
    session_id: String,
) -> Result<Value, String> {
    let (url, bearer) = agent_target(&app, &agent_base, &format!("/sessions/{}/transcript", session_id))?;
    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if let Some(t) = &bearer {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_session(
    app: tauri::AppHandle,
    agent_base: String,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let (url, bearer) = agent_target(&app, &agent_base, &format!("/sessions/{}", session_id))?;
    let client = reqwest::Client::new();
    let mut req = client.patch(&url).json(&serde_json::json!({ "title": title }));
    if let Some(t) = &bearer {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn archive_session(
    app: tauri::AppHandle,
    agent_base: String,
    session_id: String,
) -> Result<(), String> {
    let (url, bearer) = agent_target(&app, &agent_base, &format!("/sessions/{}/archive", session_id))?;
    let client = reqwest::Client::new();
    let mut req = client.post(&url);
    if let Some(t) = &bearer {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    Ok(())
}
```

- [ ] **Step 2: Rust — session streams with close sentinel**

In `StreamState`, add a sessions map:

```rust
pub struct StreamState {
    pub agent: Mutex<HashMap<String, CancellationToken>>,
    pub session: Mutex<HashMap<String, CancellationToken>>,
    pub registry: Mutex<Option<CancellationToken>>,
    pub pending: Mutex<Option<CancellationToken>>,
    pub infra: Mutex<Option<CancellationToken>>,
}
```

(Keep `#[derive(Default)]`.) Add the commands:

```rust
#[tauri::command]
pub async fn start_session_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, StreamState>,
    agent_base: String,
    session_id: String,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let (url, bearer) = agent_target(&app, &agent_base, &format!("/sessions/{}/stream", session_id))?;
    let token = CancellationToken::new();
    if let Some(old) = state.session.lock().unwrap().insert(session_id.clone(), token.clone()) {
        old.cancel();
    }
    tokio::spawn(async move {
        pump(url, bearer, on_event.clone(), token.clone()).await;
        // The stream ended (network drop, host restart, or cancel). Tell the
        // webview so it can retry; harmless if the channel is already gone.
        if !token.is_cancelled() {
            let _ = on_event.send(serde_json::json!({ "type": "stream_closed" }));
        }
    });
    Ok(())
}

#[tauri::command]
pub fn stop_session_stream(state: tauri::State<'_, StreamState>, session_id: String) {
    if let Some(tok) = state.session.lock().unwrap().remove(&session_id) {
        tok.cancel();
    }
}
```

Register all six in `lib.rs`'s `generate_handler!` next to the other `proxy::*` entries: `proxy::list_sessions, proxy::get_transcript, proxy::rename_session, proxy::archive_session, proxy::start_session_stream, proxy::stop_session_stream,`.

- [ ] **Step 3: Verify Rust**

Run: `cd client/src-tauri && cargo test` → compiles, existing tests PASS.

- [ ] **Step 4: TS wrappers**

In `client/src/lib/types.ts`, append the `SessionMeta` interface (exact shape from Interfaces above). In `client/src/lib/tauri.ts`, append:

```ts
import type { SessionMeta } from "./types";
import type { TranscriptMessage } from "./agentEvents";

export async function listSessions(agentBase: string): Promise<SessionMeta[]> {
  const r = await invoke<{ sessions: SessionMeta[] }>("list_sessions", { agentBase });
  return r.sessions;
}

export async function getTranscript(agentBase: string, sessionId: string): Promise<TranscriptMessage[]> {
  const r = await invoke<{ messages: TranscriptMessage[] }>("get_transcript", { agentBase, sessionId });
  return r.messages;
}

export function renameSession(agentBase: string, sessionId: string, title: string): Promise<void> {
  return invoke("rename_session", { agentBase, sessionId, title });
}

export function archiveSession(agentBase: string, sessionId: string): Promise<void> {
  return invoke("archive_session", { agentBase, sessionId });
}

export function openSessionStream(
  agentBase: string,
  sessionId: string,
  onEvent: (e: unknown) => void,
): () => void {
  const channel = new Channel<unknown>();
  channel.onmessage = onEvent;
  void invoke("start_session_stream", { agentBase, sessionId, onEvent: channel });
  return () => void invoke("stop_session_stream", { sessionId });
}
```

(Merge the type import with the existing `./types` import.)

- [ ] **Step 5: Verify TS and commit**

Run: `cd client && npm run typecheck` → PASS.

```bash
git add client/src-tauri/src/proxy.rs client/src-tauri/src/lib.rs client/src/lib/tauri.ts client/src/lib/types.ts
git commit -m "feat(client): session proxy commands and session streams with close sentinel"
```

---

### Task 5: client — keyed chat store (pure module)

**Files:**
- Create: `client/src/lib/chatStore.ts`
- Test: `client/test/chatStore.test.ts`

**Interfaces:**
- Consumes: `AgentState`, `initialAgentState`, `reduceAgent`, `appendUserMessage` from `client/src/lib/agentEvents.ts`; `AgentEvent` from types.
- Produces (Task 6 consumes; all pure functions over a `ChatStore` value):

```ts
export interface TabState {
  key: string;              // sessionId or "draft:<uuid>"
  title: string;
  agent: AgentState;
  openTurns: number;
  unread: boolean;
  stale: boolean;           // session stream currently down
  historyNotice: boolean;   // transcript unavailable
}
export interface ChatStore { tabs: TabState[]; activeKey: string | null }
export const emptyStore: ChatStore;
export function openTab(s: ChatStore, key: string, title: string, seed?: TranscriptMessage[]): ChatStore;
export function closeTab(s: ChatStore, key: string): ChatStore;
export function focusTab(s: ChatStore, key: string): ChatStore;       // clears unread
export function reduceEvent(s: ChatStore, key: string, e: AgentEvent): ChatStore; // marks unread if key !== activeKey
export function addUserMessage(s: ChatStore, key: string, text: string, attachments?: string[]): ChatStore;
export function bumpTurns(s: ChatStore, key: string, delta: 1 | -1): ChatStore;
export function promoteDraft(s: ChatStore, draftKey: string, sessionId: string): ChatStore;
export function setStale(s: ChatStore, key: string, stale: boolean): ChatStore;
export function setTitle(s: ChatStore, key: string, title: string): ChatStore;
export function setHistoryNotice(s: ChatStore, key: string): ChatStore;
```

- [ ] **Step 1: Write the failing tests**

Create `client/test/chatStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  emptyStore, openTab, closeTab, focusTab, reduceEvent,
  addUserMessage, bumpTurns, promoteDraft, setStale,
} from "../src/lib/chatStore";

describe("chatStore", () => {
  it("openTab adds a focused tab seeded with history and focusing twice is a no-op", () => {
    let s = openTab(emptyStore, "s1", "First", [{ kind: "user", text: "old" }]);
    expect(s.activeKey).toBe("s1");
    expect(s.tabs[0].agent.messages).toEqual([{ kind: "user", text: "old" }]);
    expect(s.tabs[0].agent.sessionId).toBe("s1"); // resumed sends continue the session
    const again = openTab(s, "s1", "First");
    expect(again.tabs).toHaveLength(1);
  });

  it("draft tabs start with a null sessionId", () => {
    const s = openTab(emptyStore, "draft:x", "New session");
    expect(s.tabs[0].agent.sessionId).toBeNull();
  });

  it("events reduce into the right tab and set unread only when unfocused", () => {
    let s = openTab(emptyStore, "s1", "One");
    s = openTab(s, "s2", "Two"); // s2 focused now
    s = reduceEvent(s, "s1", { type: "result", result: "done", isError: false });
    const t1 = s.tabs.find((t) => t.key === "s1")!;
    expect(t1.agent.messages).toHaveLength(1);
    expect(t1.unread).toBe(true);
    s = focusTab(s, "s1");
    expect(s.tabs.find((t) => t.key === "s1")!.unread).toBe(false);
    // focused tab never marks unread
    s = reduceEvent(s, "s1", { type: "error", message: "x" });
    expect(s.tabs.find((t) => t.key === "s1")!.unread).toBe(false);
  });

  it("bumpTurns floors at zero and closeTab picks a neighbor focus", () => {
    let s = openTab(emptyStore, "s1", "One");
    s = bumpTurns(s, "s1", -1);
    expect(s.tabs[0].openTurns).toBe(0);
    s = openTab(s, "s2", "Two");
    s = closeTab(s, "s2");
    expect(s.activeKey).toBe("s1");
    expect(s.tabs).toHaveLength(1);
  });

  it("promoteDraft re-keys a draft tab and keeps its state", () => {
    let s = openTab(emptyStore, "draft:tmp1", "New session");
    s = addUserMessage(s, "draft:tmp1", "hello", []);
    s = promoteDraft(s, "draft:tmp1", "real-id");
    expect(s.tabs[0].key).toBe("real-id");
    expect(s.activeKey).toBe("real-id");
    expect(s.tabs[0].agent.messages[0]).toMatchObject({ kind: "user", text: "hello" });
  });

  it("setStale flags a tab", () => {
    let s = openTab(emptyStore, "s1", "One");
    s = setStale(s, "s1", true);
    expect(s.tabs[0].stale).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/chatStore.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

Create `client/src/lib/chatStore.ts`:

```ts
import {
  initialAgentState, reduceAgent, appendUserMessage,
  type AgentState, type TranscriptMessage,
} from "./agentEvents";
import type { AgentEvent } from "./types";

export interface TabState {
  key: string;
  title: string;
  agent: AgentState;
  openTurns: number;
  unread: boolean;
  stale: boolean;
  historyNotice: boolean;
}

export interface ChatStore {
  tabs: TabState[];
  activeKey: string | null;
}

export const emptyStore: ChatStore = { tabs: [], activeKey: null };

function mapTab(s: ChatStore, key: string, fn: (t: TabState) => TabState): ChatStore {
  return { ...s, tabs: s.tabs.map((t) => (t.key === key ? fn(t) : t)) };
}

export function openTab(
  s: ChatStore,
  key: string,
  title: string,
  seed?: TranscriptMessage[],
): ChatStore {
  if (s.tabs.some((t) => t.key === key)) return focusTab(s, key);
  // Real session keys carry their id into AgentState so resumed sends
  // continue the session instead of starting a new one; drafts stay null
  // until their first session event.
  const sessionId = key.startsWith("draft:") ? null : key;
  const tab: TabState = {
    key,
    title,
    agent: { ...initialAgentState, sessionId, messages: seed ?? [] },
    openTurns: 0,
    unread: false,
    stale: false,
    historyNotice: false,
  };
  return { tabs: [...s.tabs, tab], activeKey: key };
}

export function closeTab(s: ChatStore, key: string): ChatStore {
  const idx = s.tabs.findIndex((t) => t.key === key);
  if (idx === -1) return s;
  const tabs = s.tabs.filter((t) => t.key !== key);
  const activeKey =
    s.activeKey === key ? (tabs[idx - 1]?.key ?? tabs[idx]?.key ?? null) : s.activeKey;
  return { tabs, activeKey };
}

export function focusTab(s: ChatStore, key: string): ChatStore {
  return { ...mapTab(s, key, (t) => ({ ...t, unread: false })), activeKey: key };
}

export function reduceEvent(s: ChatStore, key: string, e: AgentEvent): ChatStore {
  return mapTab(s, key, (t) => ({
    ...t,
    agent: reduceAgent(t.agent, e),
    unread: t.unread || s.activeKey !== key,
  }));
}

export function addUserMessage(
  s: ChatStore,
  key: string,
  text: string,
  attachments?: string[],
): ChatStore {
  return mapTab(s, key, (t) => ({ ...t, agent: appendUserMessage(t.agent, text, attachments) }));
}

export function bumpTurns(s: ChatStore, key: string, delta: 1 | -1): ChatStore {
  return mapTab(s, key, (t) => ({ ...t, openTurns: Math.max(0, t.openTurns + delta) }));
}

export function promoteDraft(s: ChatStore, draftKey: string, sessionId: string): ChatStore {
  if (s.tabs.some((t) => t.key === sessionId)) return closeTab(s, draftKey);
  return {
    tabs: s.tabs.map((t) => (t.key === draftKey ? { ...t, key: sessionId } : t)),
    activeKey: s.activeKey === draftKey ? sessionId : s.activeKey,
  };
}

export function setStale(s: ChatStore, key: string, stale: boolean): ChatStore {
  return mapTab(s, key, (t) => ({ ...t, stale }));
}

export function setTitle(s: ChatStore, key: string, title: string): ChatStore {
  return mapTab(s, key, (t) => ({ ...t, title }));
}

export function setHistoryNotice(s: ChatStore, key: string): ChatStore {
  return mapTab(s, key, (t) => ({ ...t, historyNotice: true }));
}
```

- [ ] **Step 4: Run tests**

Run: `cd client && npm test` → all PASS (existing suites unaffected).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/chatStore.ts client/test/chatStore.test.ts
git commit -m "feat(client): keyed multi-session chat store"
```

---

### Task 6: client — `useChatSessions` hook (streams, hydration, send)

**Files:**
- Create: `client/src/hooks/useChatSessions.ts`
- Test: `client/test/useChatSessions.test.tsx`

**Interfaces:**
- Consumes: chatStore (Task 5); `openAgentStream`, `sendMessage`, `uploadFile`, `getTranscript`, `openSessionStream` from `lib/tauri`; `StagedFile` from Composer.
- Produces (Tasks 8–9 consume):

```ts
export interface ChatSessionsApi {
  store: ChatStore;
  openSession(meta: { id: string; title: string }): Promise<void>; // hydrate + stream + focus
  newDraft(): void;                                                 // opens "draft:<uuid>" tab
  close(key: string): void;
  focus(key: string): void;
  send(key: string, text: string, files: StagedFile[]): Promise<boolean>;
  setTabTitle(key: string, title: string): void;
}
export function useChatSessions(agentBase: string): ChatSessionsApi;
```

Behavior contract:
- `openSession`: `getTranscript` → seed via `openTab`; on transcript error, open with `seed = [{ kind: "result", text: "History unavailable for this session" }]` and set historyNotice. Then `openSessionStream`; events reduce via `reduceEvent`; a `{type:"stream_closed"}` value sets stale and retries with backoff 2s → 5s → 15s (cap), clearing stale on the first event after reconnect.
- `send`: same upload/prompt logic AgentPanel has today (uploads first, `[Attached files: …]` suffix, error → `reduceEvent` error + return false), user message via `addUserMessage`, `bumpTurns(+1)`, stream-first turn flow, sessionId = the tab's `agent.sessionId` (undefined for drafts). On the turn's `session` event for a draft tab, call `promoteDraft(draftKey, sessionId)` and start that session's live stream.
- `close`: stops the session stream (and any turn streams for that key) and `closeTab`.

- [ ] **Step 1: Write the failing tests**

Create `client/test/useChatSessions.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { AgentEvent } from "../src/lib/types";

const turnHandlers = new Map<string, (e: AgentEvent) => void>();
const sessionHandlers = new Map<string, (e: unknown) => void>();
const stopTurn = vi.fn();
const stopSession = vi.fn();

vi.mock("../src/lib/tauri", () => ({
  openAgentStream: vi.fn((_b: string, turnId: string, on: (e: AgentEvent) => void) => {
    turnHandlers.set(turnId, on);
    return stopTurn;
  }),
  openSessionStream: vi.fn((_b: string, sessionId: string, on: (e: unknown) => void) => {
    sessionHandlers.set(sessionId, on);
    return stopSession;
  }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn().mockResolvedValue("uploads/f.txt"),
  getTranscript: vi.fn().mockResolvedValue([{ kind: "user", text: "from history" }]),
}));

import { useChatSessions } from "../src/hooks/useChatSessions";
import { getTranscript, openSessionStream, sendMessage } from "../src/lib/tauri";

beforeEach(() => {
  vi.clearAllMocks();
  turnHandlers.clear();
  sessionHandlers.clear();
});

describe("useChatSessions", () => {
  it("openSession hydrates history then attaches a live stream", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    await act(() => result.current.openSession({ id: "s1", title: "Old" }));
    expect(getTranscript).toHaveBeenCalledWith("http://a:8787", "s1");
    expect(openSessionStream).toHaveBeenCalledWith("http://a:8787", "s1", expect.any(Function));
    expect(result.current.store.tabs[0].agent.messages[0]).toEqual({ kind: "user", text: "from history" });
    act(() => sessionHandlers.get("s1")!({ type: "result", result: "live", isError: false }));
    expect(result.current.store.tabs[0].agent.messages).toHaveLength(2);
  });

  it("transcript failure opens the tab with a history notice", async () => {
    (getTranscript as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("404"));
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    await act(() => result.current.openSession({ id: "s2", title: "NoHist" }));
    expect(result.current.store.tabs[0].agent.messages[0].text).toMatch(/history unavailable/i);
    expect(result.current.store.tabs[0].historyNotice).toBe(true);
  });

  it("a draft promotes to the real session id on the first session event", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    act(() => result.current.newDraft());
    const draftKey = result.current.store.tabs[0].key;
    expect(draftKey).toMatch(/^draft:/);
    await act(() => result.current.send(draftKey, "hello", []));
    const turnOn = [...turnHandlers.values()][0];
    act(() => turnOn({ type: "session", sessionId: "real-1" }));
    expect(result.current.store.tabs[0].key).toBe("real-1");
    expect(openSessionStream).toHaveBeenCalledWith("http://a:8787", "real-1", expect.any(Function));
  });

  it("background session events mark unread; stream_closed marks stale", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    await act(() => result.current.openSession({ id: "s1", title: "One" }));
    await act(() => result.current.openSession({ id: "s2", title: "Two" }));
    act(() => sessionHandlers.get("s1")!({ type: "result", result: "bg", isError: false }));
    expect(result.current.store.tabs.find((t) => t.key === "s1")!.unread).toBe(true);
    act(() => sessionHandlers.get("s1")!({ type: "stream_closed" }));
    expect(result.current.store.tabs.find((t) => t.key === "s1")!.stale).toBe(true);
  });

  it("send uploads, appends the attached-files block, and resolves true", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    await act(() => result.current.openSession({ id: "s1", title: "One" }));
    let ok = false;
    await act(async () => {
      ok = await result.current.send("s1", "look", [{ name: "f.txt", contentBase64: "aGk=" }]);
    });
    expect(ok).toBe(true);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        "http://a:8787", expect.any(String), "look\n\n[Attached files: uploads/f.txt]", "s1",
      ),
    );
  });

  it("close stops the session stream and removes the tab", async () => {
    const { result } = renderHook(() => useChatSessions("http://a:8787"));
    await act(() => result.current.openSession({ id: "s1", title: "One" }));
    act(() => result.current.close("s1"));
    expect(stopSession).toHaveBeenCalled();
    expect(result.current.store.tabs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/useChatSessions.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement**

Create `client/src/hooks/useChatSessions.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import {
  emptyStore, openTab, closeTab, focusTab, reduceEvent, addUserMessage,
  bumpTurns, promoteDraft, setStale, setTitle, setHistoryNotice,
  type ChatStore,
} from "../lib/chatStore";
import {
  openAgentStream, openSessionStream, sendMessage, uploadFile, getTranscript,
} from "../lib/tauri";
import type { AgentEvent } from "../lib/types";
import type { StagedFile } from "../components/Composer";

export interface ChatSessionsApi {
  store: ChatStore;
  openSession(meta: { id: string; title: string }): Promise<void>;
  newDraft(): void;
  close(key: string): void;
  focus(key: string): void;
  send(key: string, text: string, files: StagedFile[]): Promise<boolean>;
  setTabTitle(key: string, title: string): void;
}

const RETRY_DELAYS = [2000, 5000, 15000];

export function useChatSessions(agentBase: string): ChatSessionsApi {
  const [store, setStore] = useState<ChatStore>(emptyStore);
  const storeRef = useRef(store);
  storeRef.current = store;

  const sessionStops = useRef(new Map<string, () => void>());
  const turnStops = useRef(new Map<string, () => void>());
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const retryCount = useRef(new Map<string, number>());
  // key under which each turn's events should reduce (draft keys re-point on promote)
  const turnKey = useRef(new Map<string, string>());

  useEffect(() => {
    const sessions = sessionStops.current;
    const turns = turnStops.current;
    const timers = retryTimers.current;
    return () => {
      for (const stop of sessions.values()) stop();
      for (const stop of turns.values()) stop();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  function attachSessionStream(sessionId: string) {
    sessionStops.current.get(sessionId)?.();
    const stop = openSessionStream(agentBase, sessionId, (raw) => {
      const e = raw as { type?: string };
      if (e?.type === "stream_closed") {
        setStore((s) => setStale(s, sessionId, true));
        const n = retryCount.current.get(sessionId) ?? 0;
        const delay = RETRY_DELAYS[Math.min(n, RETRY_DELAYS.length - 1)];
        retryCount.current.set(sessionId, n + 1);
        retryTimers.current.set(
          sessionId,
          setTimeout(() => {
            if (storeRef.current.tabs.some((t) => t.key === sessionId)) {
              attachSessionStream(sessionId);
            }
          }, delay),
        );
        return;
      }
      retryCount.current.set(sessionId, 0);
      setStore((s) => reduceEvent(setStale(s, sessionId, false), sessionId, raw as AgentEvent));
    });
    sessionStops.current.set(sessionId, stop);
  }

  async function openSession(meta: { id: string; title: string }) {
    if (storeRef.current.tabs.some((t) => t.key === meta.id)) {
      setStore((s) => focusTab(s, meta.id));
      return;
    }
    let seed;
    let failed = false;
    try {
      seed = await getTranscript(agentBase, meta.id);
    } catch {
      failed = true;
      seed = [{ kind: "result" as const, text: "History unavailable for this session" }];
    }
    setStore((s) => {
      let next = openTab(s, meta.id, meta.title, seed);
      if (failed) next = setHistoryNotice(next, meta.id);
      return next;
    });
    attachSessionStream(meta.id);
  }

  function newDraft() {
    const key = `draft:${crypto.randomUUID()}`;
    setStore((s) => openTab(s, key, "New session"));
  }

  function close(key: string) {
    sessionStops.current.get(key)?.();
    sessionStops.current.delete(key);
    const timer = retryTimers.current.get(key);
    if (timer) clearTimeout(timer);
    setStore((s) => closeTab(s, key));
  }

  function focus(key: string) {
    setStore((s) => focusTab(s, key));
  }

  function setTabTitle(key: string, title: string) {
    setStore((s) => setTitle(s, key, title));
  }

  async function send(key: string, text: string, files: StagedFile[]): Promise<boolean> {
    let prompt = text;
    if (files.length > 0) {
      try {
        const paths: string[] = [];
        for (const f of files) paths.push(await uploadFile(agentBase, f.name, f.contentBase64));
        prompt = `${text}\n\n[Attached files: ${paths.join(", ")}]`;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setStore((s) => reduceEvent(s, key, { type: "error", message: `Upload failed: ${detail}` }));
        return false;
      }
    }
    setStore((s) => addUserMessage(s, key, text, files.map((f) => f.name)));

    const tab = storeRef.current.tabs.find((t) => t.key === key);
    const sessionId = tab?.agent.sessionId ?? undefined;
    const turnId = crypto.randomUUID();
    turnKey.current.set(turnId, key);
    setStore((s) => bumpTurns(s, key, 1));

    const stop = openAgentStream(agentBase, turnId, (event) => {
      const k = turnKey.current.get(turnId) ?? key;
      if (event.type === "session" && k.startsWith("draft:")) {
        turnKey.current.set(turnId, event.sessionId);
        setStore((s) => promoteDraft(s, k, event.sessionId));
        attachSessionStream(event.sessionId);
      }
      // The session stream (attached above) will also deliver this turn's
      // events for promoted/opened sessions; the turn stream is authoritative
      // for draft tabs and for turn accounting.
      setStore((s) => reduceEvent(s, turnKey.current.get(turnId) ?? k, event));
      if (event.type === "result" || event.type === "error") {
        if (turnStops.current.has(turnId)) {
          turnStops.current.get(turnId)?.();
          turnStops.current.delete(turnId);
          setStore((s) => bumpTurns(s, turnKey.current.get(turnId) ?? k, -1));
        }
      }
    });
    turnStops.current.set(turnId, stop);

    try {
      await sendMessage(agentBase, turnId, prompt, sessionId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const k = turnKey.current.get(turnId) ?? key;
      if (turnStops.current.has(turnId)) {
        turnStops.current.get(turnId)?.();
        turnStops.current.delete(turnId);
        setStore((s) => bumpTurns(s, k, -1));
      }
      setStore((s) => reduceEvent(s, k, { type: "error", message: `Send failed: ${detail}` }));
      return false;
    }
    return true;
  }

  return { store, openSession, newDraft, close, focus, send, setTabTitle };
}
```

**Known double-delivery caveat (accepted per spec):** for a tab with an attached session stream, a locally sent turn's events arrive on BOTH the turn stream and the session stream. To keep this phase simple and match the spec's accepted-duplication note, mitigate the common case: when a tab has an attached session stream, the turn-stream callback must reduce ONLY `session` events (for promotion) and the result/error turn-accounting — not message content. Implement by checking `sessionStops.current.has(k)` before the content `reduceEvent` call:

```ts
      const hasSessionStream = sessionStops.current.has(turnKey.current.get(turnId) ?? k);
      if (!hasSessionStream) {
        setStore((s) => reduceEvent(s, turnKey.current.get(turnId) ?? k, event));
      }
```

(Turn accounting — the `result`/`error` bumpTurns block — always runs. Draft tabs have no session stream until promotion, so their first turn renders via the turn stream; the session stream attaches on promotion and covers subsequent events. The `send uploads…` unit test above uses an OPENED session with a mocked session stream, so its assertion checks `sendMessage` args, not transcript growth via the turn stream.)

- [ ] **Step 4: Run tests**

Run: `cd client && npx vitest run test/useChatSessions.test.tsx` → PASS; then `npm test` → all PASS; `npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useChatSessions.ts client/test/useChatSessions.test.tsx
git commit -m "feat(client): multi-session chat hook with hydration, live streams, retry"
```

---

### Task 7: client — rail + panel shell (Workspace restructure)

**Files:**
- Create: `client/src/components/Rail.tsx`, `client/src/components/GearPanel.tsx`
- Modify: `client/src/components/Workspace.tsx`
- Test: `client/test/Workspace.test.tsx` (create), `client/test/App.test.tsx` (existing disconnect test must keep passing)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `<Rail active={RailSection|null} onSelect={(s: RailSection) => void} />` where `export type RailSection = "sessions" | "surfaces" | "gear"`; buttons have `aria-label` "Sessions", "Surfaces", "Connection". Clicking the active icon collapses the panel (`onSelect` with the same value; parent toggles to null).
  - `<GearPanel agentBase dashboardBase onDisconnect />` — host URLs (monospace, truncated) + Disconnect button (accessible name "Disconnect", preserved for the existing App test).
  - `Workspace` keeps props `{ agentBase, dashboardBase, onDisconnect }`; internally: rail (left, w-12), panel (w-64, rendered only when a section is active; sessions/surfaces contents are placeholder slots filled by Tasks 8–10), main = existing chat/canvas split. Top status bar REMOVED.

- [ ] **Step 1: Write the failing tests**

Create `client/test/Workspace.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Workspace } from "../src/components/Workspace";

vi.mock("../src/lib/tauri", () => ({
  openAgentStream: vi.fn(() => () => {}),
  openSessionStream: vi.fn(() => () => {}),
  openRegistryStream: vi.fn(() => () => {}),
  sendMessage: vi.fn(),
  uploadFile: vi.fn(),
  getTranscript: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn().mockResolvedValue([]),
  renameSession: vi.fn(),
  archiveSession: vi.fn(),
}));

function setup() {
  const onDisconnect = vi.fn();
  render(<Workspace agentBase="http://a:8787" dashboardBase="http://d:8788" onDisconnect={onDisconnect} />);
  return { onDisconnect };
}

describe("Workspace shell", () => {
  it("renders the rail with Sessions, Surfaces, and Connection buttons", () => {
    setup();
    expect(screen.getByRole("button", { name: "Sessions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Surfaces" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connection" })).toBeTruthy();
  });

  it("gear panel shows hosts and Disconnect works; clicking the icon again collapses", async () => {
    const { onDisconnect } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Connection" }));
    expect(screen.getByText("http://a:8787")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Connection" }));
    expect(screen.queryByText("http://a:8787")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/Workspace.test.tsx` → FAIL (no rail buttons).

- [ ] **Step 3: Implement**

`client/src/components/Rail.tsx`:

```tsx
export type RailSection = "sessions" | "surfaces" | "gear";

const ITEMS: { id: RailSection; label: string; glyph: string }[] = [
  { id: "sessions", label: "Sessions", glyph: "💬" },
  { id: "surfaces", label: "Surfaces", glyph: "▦" },
];

export function Rail({
  active,
  onSelect,
}: {
  active: RailSection | null;
  onSelect: (s: RailSection) => void;
}) {
  const btn = (id: RailSection, label: string, glyph: string) => (
    <button
      key={id}
      aria-label={label}
      title={label}
      onClick={() => onSelect(id)}
      className={
        active === id
          ? "flex h-10 w-10 items-center justify-center rounded bg-raised text-ink border border-line"
          : "flex h-10 w-10 items-center justify-center rounded text-muted hover:text-ink"
      }
    >
      <span aria-hidden>{glyph}</span>
    </button>
  );
  return (
    <nav className="flex w-12 flex-col items-center gap-1 border-r border-line bg-panel py-2">
      {ITEMS.map((i) => btn(i.id, i.label, i.glyph))}
      <div className="flex-1" />
      {btn("gear", "Connection", "⚙")}
    </nav>
  );
}
```

`client/src/components/GearPanel.tsx`:

```tsx
export function GearPanel({
  agentBase,
  dashboardBase,
  onDisconnect,
}: {
  agentBase: string;
  dashboardBase: string;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Connection</h2>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">Agent host</span>
        <span className="truncate font-mono text-sm">{agentBase}</span>
        <span className="mt-1 text-xs text-muted">Dashboard host</span>
        <span className="truncate font-mono text-sm">{dashboardBase}</span>
      </div>
      <button
        onClick={onDisconnect}
        className="self-start rounded border border-line px-2 py-1 text-sm text-muted hover:border-danger hover:text-danger"
      >
        Disconnect
      </button>
    </div>
  );
}
```

`client/src/components/Workspace.tsx` — restructure (chat/canvas split unchanged inside `main`; Sessions/Surfaces panel bodies are empty placeholders until Tasks 8/10):

```tsx
import { useState } from "react";
import { AgentPanel } from "./AgentPanel";
import { Canvas } from "./Canvas";
import { Rail, type RailSection } from "./Rail";
import { GearPanel } from "./GearPanel";

export function Workspace({
  agentBase,
  dashboardBase,
  onDisconnect,
}: {
  agentBase: string;
  dashboardBase: string;
  onDisconnect: () => void;
}) {
  const [section, setSection] = useState<RailSection | null>(null);

  function toggle(s: RailSection) {
    setSection((cur) => (cur === s ? null : s));
  }

  return (
    <div className="flex h-screen">
      <Rail active={section} onSelect={toggle} />
      {section !== null && (
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-line bg-panel">
          {section === "gear" && (
            <GearPanel agentBase={agentBase} dashboardBase={dashboardBase} onDisconnect={onDisconnect} />
          )}
          {section === "sessions" && <div data-testid="sessions-panel-slot" />}
          {section === "surfaces" && <div data-testid="surfaces-panel-slot" />}
        </aside>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="min-w-64 w-2/5 max-w-[70%] resize-x overflow-hidden border-r border-line">
          <AgentPanel agentBase={agentBase} />
        </div>
        <div className="min-w-0 flex-1">
          <Canvas dashboardBase={dashboardBase} />
        </div>
      </div>
    </div>
  );
}
```

Check `client/test/App.test.tsx`: its disconnect test clicks the button by name — it now lives behind the gear panel. Update that test to click `Connection` first:

```ts
await userEvent.click(await screen.findByRole("button", { name: "Connection" }));
const btn = await screen.findByRole("button", { name: /disconnect/i });
```

(Only the navigation step changes; assertions stay.)

- [ ] **Step 4: Run tests**

Run: `cd client && npm test` → all PASS (including adapted App test).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Rail.tsx client/src/components/GearPanel.tsx client/src/components/Workspace.tsx client/test/Workspace.test.tsx client/test/App.test.tsx
git commit -m "feat(client): icon-rail navigation shell with collapsible panel"
```

---

### Task 8: client — SessionsPanel

**Files:**
- Create: `client/src/components/SessionsPanel.tsx`
- Test: `client/test/SessionsPanel.test.tsx`

**Interfaces:**
- Consumes: `listSessions`, `renameSession`, `archiveSession` from `lib/tauri`; `SessionMeta` from `lib/types`; tab state from Task 5's `ChatStore` (running/unread badges derive from `tabs`).
- Produces (Task 9 mounts it):

```tsx
<SessionsPanel
  agentBase={string}
  tabs={TabState[]}                 // for badges
  onOpen={(meta: SessionMeta) => void}
  onNew={() => void}
/>
```

DOM contract: "New session" button; list items are buttons named by title; per-item hover actions "Rename <title>" and "Archive <title>"; rename swaps to a text input submitted on Enter.

- [ ] **Step 1: Write the failing tests**

Create `client/test/SessionsPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionMeta } from "../src/lib/types";

const sessions: SessionMeta[] = [
  { id: "s1", title: "Printer digest", createdAt: "2026-07-01T00:00:00Z", lastActiveAt: "2026-07-02T00:00:00Z", preview: "…", archived: false },
  { id: "s2", title: "Ontology sync", createdAt: "2026-07-01T00:00:00Z", lastActiveAt: "2026-07-01T12:00:00Z", preview: "…", archived: false },
];

vi.mock("../src/lib/tauri", () => ({
  listSessions: vi.fn(async () => sessions),
  renameSession: vi.fn().mockResolvedValue(undefined),
  archiveSession: vi.fn().mockResolvedValue(undefined),
}));

import { SessionsPanel } from "../src/components/SessionsPanel";
import { listSessions, renameSession, archiveSession } from "../src/lib/tauri";

beforeEach(() => vi.clearAllMocks());

function setup(tabs: any[] = []) {
  const onOpen = vi.fn();
  const onNew = vi.fn();
  render(<SessionsPanel agentBase="http://a:8787" tabs={tabs} onOpen={onOpen} onNew={onNew} />);
  return { onOpen, onNew };
}

describe("SessionsPanel", () => {
  it("lists sessions from the host and opens one on click", async () => {
    const { onOpen } = setup();
    await userEvent.click(await screen.findByRole("button", { name: /printer digest/i }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });

  it("New session triggers onNew", async () => {
    const { onNew } = setup();
    await userEvent.click(await screen.findByRole("button", { name: /new session/i }));
    expect(onNew).toHaveBeenCalled();
  });

  it("renames inline and refreshes", async () => {
    setup();
    await screen.findByRole("button", { name: /printer digest/i });
    await userEvent.click(screen.getByRole("button", { name: "Rename Printer digest" }));
    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "Digest v2{Enter}");
    await waitFor(() => expect(renameSession).toHaveBeenCalledWith("http://a:8787", "s1", "Digest v2"));
    expect(listSessions).toHaveBeenCalledTimes(2); // initial + refresh
  });

  it("archives and refreshes", async () => {
    setup();
    await screen.findByRole("button", { name: /ontology sync/i });
    await userEvent.click(screen.getByRole("button", { name: "Archive Ontology sync" }));
    await waitFor(() => expect(archiveSession).toHaveBeenCalledWith("http://a:8787", "s2"));
  });

  it("shows running and unread badges from tab state", async () => {
    setup([
      { key: "s1", openTurns: 1, unread: false },
      { key: "s2", openTurns: 0, unread: true },
    ]);
    await screen.findByRole("button", { name: /printer digest/i });
    expect(screen.getByLabelText("s1 running")).toBeTruthy();
    expect(screen.getByLabelText("s2 unread")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/SessionsPanel.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement**

Create `client/src/components/SessionsPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import { listSessions, renameSession, archiveSession } from "../lib/tauri";
import type { SessionMeta } from "../lib/types";

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

interface BadgeTab { key: string; openTurns: number; unread: boolean }

export function SessionsPanel({
  agentBase,
  tabs,
  onOpen,
  onNew,
}: {
  agentBase: string;
  tabs: BadgeTab[];
  onOpen: (meta: SessionMeta) => void;
  onNew: () => void;
}) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  async function refresh() {
    try {
      setSessions(await listSessions(agentBase));
    } catch {
      // host unreachable: keep the last list
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentBase]);

  async function submitRename(id: string) {
    const title = draftTitle.trim();
    setRenaming(null);
    if (!title) return;
    try {
      await renameSession(agentBase, id, title);
    } finally {
      void refresh();
    }
  }

  async function archive(id: string) {
    try {
      await archiveSession(agentBase, id);
    } finally {
      void refresh();
    }
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      <button
        onClick={onNew}
        className="rounded bg-accent px-2 py-1.5 text-sm font-medium text-white"
      >
        New session
      </button>
      <ul className="flex flex-col gap-0.5">
        {sessions.map((s) => {
          const tab = tabs.find((t) => t.key === s.id);
          return (
            <li key={s.id} className="group relative">
              {renaming === s.id ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitRename(s.id);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onBlur={() => setRenaming(null)}
                  className="w-full rounded border border-accent bg-raised px-2 py-1 text-sm outline-none"
                />
              ) : (
                <button
                  onClick={() => onOpen(s)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-raised"
                >
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  {tab && tab.openTurns > 0 && (
                    <span aria-label={`${s.id} running`} className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                  )}
                  {tab?.unread && (
                    <span aria-label={`${s.id} unread`} className="h-2 w-2 rounded-full bg-accent-soft border border-accent" />
                  )}
                  <span className="shrink-0 text-xs text-muted">{relTime(s.lastActiveAt)}</span>
                </button>
              )}
              {renaming !== s.id && (
                <span className="absolute right-1 top-1 hidden gap-1 group-hover:flex">
                  <button
                    aria-label={`Rename ${s.title}`}
                    onClick={() => {
                      setRenaming(s.id);
                      setDraftTitle(s.title);
                    }}
                    className="rounded bg-raised px-1 text-xs text-muted hover:text-ink"
                  >
                    ✎
                  </button>
                  <button
                    aria-label={`Archive ${s.title}`}
                    onClick={() => void archive(s.id)}
                    className="rounded bg-raised px-1 text-xs text-muted hover:text-danger"
                  >
                    🗄
                  </button>
                </span>
              )}
            </li>
          );
        })}
        {sessions.length === 0 && (
          <li className="px-2 py-4 text-center text-xs text-muted">No sessions yet.</li>
        )}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd client && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SessionsPanel.tsx client/test/SessionsPanel.test.tsx
git commit -m "feat(client): sessions panel with badges, rename, archive"
```

---

### Task 9: client — chat tabs + AgentPanel refactor + integration

**Files:**
- Create: `client/src/components/ChatTabs.tsx`
- Modify: `client/src/components/AgentPanel.tsx` (becomes presentational per-tab), `client/src/components/Workspace.tsx` (owns `useChatSessions`, mounts SessionsPanel + ChatTabs)
- Test: `client/test/ChatTabs.test.tsx` (create), `client/test/AgentPanel.test.tsx` (adapt), `client/test/Workspace.test.tsx` (extend)

**Interfaces:**
- Consumes: `useChatSessions` (Task 6), `SessionsPanel` (Task 8), `Transcript`/`Composer` (existing).
- Produces:

```tsx
// ChatTabs: role="tablist" aria-label="Open sessions"; tabs role="tab" named by
// title; close buttons named `Close <title>`; running spinner + unread dot.
<ChatTabs tabs={TabState[]} activeKey={string|null} onFocus={(k)=>void} onClose={(k)=>void} />

// AgentPanel becomes:
<AgentPanel
  tab={TabState}                        // state to render
  slashCommands={string[]}
  onSend={(text, files) => Promise<boolean>}
/>
```

`Workspace` wires: `useChatSessions(agentBase)`; sessions panel slot ← `SessionsPanel` (`onOpen` → `openSession`, `onNew` → `newDraft`); chat pane = `ChatTabs` + active tab's `AgentPanel` (empty state when no tabs: "Open a session or start a new one."); on first mount with zero tabs, call `newDraft()` once so the app opens ready to chat.

- [ ] **Step 1: Write the failing tests**

Create `client/test/ChatTabs.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatTabs } from "../src/components/ChatTabs";

const tabs = [
  { key: "s1", title: "One", openTurns: 1, unread: false, stale: false, historyNotice: false, agent: { sessionId: "s1", slashCommands: [], messages: [] } },
  { key: "s2", title: "Two", openTurns: 0, unread: true, stale: false, historyNotice: false, agent: { sessionId: "s2", slashCommands: [], messages: [] } },
] as any[];

describe("ChatTabs", () => {
  it("renders tabs with aria-selected, focuses on click, closes via the close button", async () => {
    const onFocus = vi.fn();
    const onClose = vi.fn();
    render(<ChatTabs tabs={tabs} activeKey="s1" onFocus={onFocus} onClose={onClose} />);
    expect(screen.getByRole("tab", { name: /one/i }).getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: /two/i }));
    expect(onFocus).toHaveBeenCalledWith("s2");
    await userEvent.click(screen.getByRole("button", { name: "Close Two" }));
    expect(onClose).toHaveBeenCalledWith("s2");
  });

  it("shows running and unread indicators", () => {
    render(<ChatTabs tabs={tabs} activeKey="s1" onFocus={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText("One running")).toBeTruthy();
    expect(screen.getByLabelText("Two unread")).toBeTruthy();
  });
});
```

Adapt `client/test/AgentPanel.test.tsx`: the panel is now presentational. Replace the mock-heavy behavior tests that moved to `useChatSessions.test.tsx` (user-bubble-on-send, thinking, upload flow, send-failure — DELETE those four; their behavior is covered by Task 6's hook tests) with:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPanel } from "../src/components/AgentPanel";
import { initialAgentState } from "../src/lib/agentEvents";

function tab(over: Partial<any> = {}) {
  return {
    key: "s1", title: "One", openTurns: 0, unread: false, stale: false,
    historyNotice: false, agent: initialAgentState, ...over,
  };
}

describe("AgentPanel (presentational)", () => {
  it("renders the transcript for its tab and forwards sends", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(<AgentPanel tab={tab()} slashCommands={[]} onSend={onSend} />);
    await userEvent.type(screen.getByRole("textbox"), "hi{Enter}");
    expect(onSend).toHaveBeenCalledWith("hi", []);
  });

  it("shows thinking while the tab has open turns", () => {
    render(<AgentPanel tab={tab({ openTurns: 1 })} slashCommands={[]} onSend={vi.fn()} />);
    expect(screen.getByText(/thinking/i)).toBeTruthy();
  });

  it("shows a stale-stream notice", () => {
    render(<AgentPanel tab={tab({ stale: true })} slashCommands={[]} onSend={vi.fn()} />);
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/ChatTabs.test.tsx test/AgentPanel.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`client/src/components/ChatTabs.tsx`:

```tsx
import type { TabState } from "../lib/chatStore";

export function ChatTabs({
  tabs,
  activeKey,
  onFocus,
  onClose,
}: {
  tabs: TabState[];
  activeKey: string | null;
  onFocus: (key: string) => void;
  onClose: (key: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div role="tablist" aria-label="Open sessions" className="flex items-center gap-1 overflow-x-auto border-b border-line bg-panel px-1 py-1">
      {tabs.map((t) => (
        <span
          key={t.key}
          className={
            t.key === activeKey
              ? "flex shrink-0 items-center gap-1.5 rounded border border-line bg-raised px-2 py-1 text-sm text-ink"
              : "flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-sm text-muted hover:text-ink"
          }
        >
          <button role="tab" aria-selected={t.key === activeKey} onClick={() => onFocus(t.key)} className="flex items-center gap-1.5">
            <span className="max-w-40 truncate">{t.title}</span>
            {t.openTurns > 0 && (
              <span aria-label={`${t.title} running`} className="h-2 w-2 animate-pulse rounded-full bg-accent" />
            )}
            {t.unread && (
              <span aria-label={`${t.title} unread`} className="h-2 w-2 rounded-full border border-accent bg-accent-soft" />
            )}
          </button>
          <button aria-label={`Close ${t.title}`} onClick={() => onClose(t.key)} className="text-muted hover:text-danger">
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
```

`client/src/components/AgentPanel.tsx` — full replacement (stream logic now lives in the hook):

```tsx
import { Transcript } from "./Transcript";
import { Composer, type StagedFile } from "./Composer";
import type { TabState } from "../lib/chatStore";

export function AgentPanel({
  tab,
  slashCommands,
  onSend,
}: {
  tab: TabState;
  slashCommands: string[];
  onSend: (text: string, files: StagedFile[]) => Promise<boolean>;
}) {
  return (
    <div className="flex h-full flex-col bg-panel">
      {tab.stale && (
        <div className="border-b border-line bg-raised px-3 py-1 text-xs text-muted">
          Live updates interrupted — reconnecting…
        </div>
      )}
      <Transcript messages={tab.agent.messages} busy={tab.openTurns > 0} />
      <Composer slashCommands={slashCommands} onSend={onSend} />
    </div>
  );
}
```

`client/src/components/Workspace.tsx` — wire everything (replacing the placeholder slots for sessions; the surfaces slot stays until Task 10):

```tsx
import { useEffect, useState } from "react";
import { Canvas } from "./Canvas";
import { Rail, type RailSection } from "./Rail";
import { GearPanel } from "./GearPanel";
import { SessionsPanel } from "./SessionsPanel";
import { ChatTabs } from "./ChatTabs";
import { AgentPanel } from "./AgentPanel";
import { useChatSessions } from "../hooks/useChatSessions";

export function Workspace({
  agentBase,
  dashboardBase,
  onDisconnect,
}: {
  agentBase: string;
  dashboardBase: string;
  onDisconnect: () => void;
}) {
  const [section, setSection] = useState<RailSection | null>(null);
  const chat = useChatSessions(agentBase);
  const active = chat.store.tabs.find((t) => t.key === chat.store.activeKey) ?? null;

  useEffect(() => {
    if (chat.store.tabs.length === 0) chat.newDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(s: RailSection) {
    setSection((cur) => (cur === s ? null : s));
  }

  return (
    <div className="flex h-screen">
      <Rail active={section} onSelect={toggle} />
      {section !== null && (
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-line bg-panel">
          {section === "gear" && (
            <GearPanel agentBase={agentBase} dashboardBase={dashboardBase} onDisconnect={onDisconnect} />
          )}
          {section === "sessions" && (
            <SessionsPanel
              agentBase={agentBase}
              tabs={chat.store.tabs}
              onOpen={(m) => void chat.openSession({ id: m.id, title: m.title })}
              onNew={() => chat.newDraft()}
            />
          )}
          {section === "surfaces" && <div data-testid="surfaces-panel-slot" />}
        </aside>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-w-64 w-2/5 max-w-[70%] resize-x flex-col overflow-hidden border-r border-line">
          <ChatTabs
            tabs={chat.store.tabs}
            activeKey={chat.store.activeKey}
            onFocus={chat.focus}
            onClose={chat.close}
          />
          {active ? (
            <AgentPanel
              tab={active}
              slashCommands={active.agent.slashCommands}
              onSend={(text, files) => chat.send(active.key, text, files)}
            />
          ) : (
            <p className="m-auto text-sm text-muted">Open a session or start a new one.</p>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <Canvas dashboardBase={dashboardBase} />
        </div>
      </div>
    </div>
  );
}
```

Extend `client/test/Workspace.test.tsx` with an integration case:

```tsx
it("opens with a draft chat tab ready to send", async () => {
  setup();
  expect(await screen.findByRole("tab", { name: /new session/i })).toBeTruthy();
  expect(screen.getByRole("textbox")).toBeTruthy();
});
```

- [ ] **Step 4: Run tests**

Run: `cd client && npm test && npm run typecheck` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ChatTabs.tsx client/src/components/AgentPanel.tsx client/src/components/Workspace.tsx client/test/ChatTabs.test.tsx client/test/AgentPanel.test.tsx client/test/Workspace.test.tsx
git commit -m "feat(client): multiple live chat tabs wired through the sessions hook"
```

---

### Task 10: client — SurfacesPanel + registry lift

**Files:**
- Create: `client/src/components/SurfacesPanel.tsx`
- Modify: `client/src/components/Canvas.tsx` (becomes presentational), `client/src/components/Workspace.tsx` (owns registry stream)
- Test: `client/test/Canvas.test.tsx` (adapt), `client/test/Workspace.test.tsx` (extend)

**Interfaces:**
- Consumes: `openRegistryStream`, `reduceRegistry`, `Tab` from existing libs.
- Produces:

```tsx
// Canvas becomes presentational:
<Canvas dashboardBase={string} tabs={Tab[]} activeId={string|null} onSelect={(id)=>void} />
// (detach logic and iframe stay inside Canvas; the security comment moves untouched)
<SurfacesPanel tabs={Tab[]} activeId={string|null} onSelect={(id)=>void} />
```

`Workspace` owns the registry stream (`useEffect` identical to Canvas's current one) and passes `tabs`/`activeId`/`onSelect` to both Canvas and SurfacesPanel; the panel lists surfaces (button per row, active highlighted) and clicking selects that canvas tab.

- [ ] **Step 1: Adapt/extend tests**

`client/test/Canvas.test.tsx`: Canvas no longer subscribes; update its render calls to pass props directly and DELETE the mocked `openRegistryStream` capture (move that pattern to Workspace tests). Keep all behavioral assertions (tab click, aria-selected, empty state, detach `WebviewWindow` args, iframe src/sandbox) — they now assert against props:

```tsx
// representative adaptation
render(<Canvas dashboardBase="http://d:8788" tabs={[]} activeId={null} onSelect={() => {}} />);
expect(await screen.findByText(/no surfaces yet/i)).toBeTruthy();
```

Extend `client/test/Workspace.test.tsx`:

```tsx
it("streams the registry and shows surfaces in the panel and canvas", async () => {
  // openRegistryStream mock: capture the callback
  const { openRegistryStream } = await import("../src/lib/tauri");
  setup();
  const cb = (openRegistryStream as ReturnType<typeof vi.fn>).mock.calls[0][1];
  act(() => cb({ surfaces: [{ id: "x1", title: "Sales", url: "/surfaces/x1/", kind: "file", created: "", updated: "" }] }));
  expect(await screen.findByRole("tab", { name: "Sales" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Surfaces" }));
  expect(screen.getByRole("button", { name: /sales/i })).toBeTruthy();
});
```

(Import `act` from `@testing-library/react`; ensure the tauri mock's `openRegistryStream` returns a stop fn.)

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/Canvas.test.tsx test/Workspace.test.tsx` → FAIL (Canvas still owns the stream; no surfaces panel).

- [ ] **Step 3: Implement**

`client/src/components/Canvas.tsx` — remove the `useEffect`/`useState` for the registry; accept props (keep `detach()` and its capability security comment EXACTLY as-is, and the iframe/tab-bar JSX unchanged apart from sourcing `tabs`/`activeId`/`onSelect` from props):

```tsx
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Tab } from "../lib/registryStore";

export function Canvas({
  dashboardBase,
  tabs,
  activeId,
  onSelect,
}: {
  dashboardBase: string;
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const activeUrl = active ? `${dashboardBase}${active.url}` : null;
  // ... detach() and the return block stay as they are today, with
  // setActiveId(t.id) replaced by onSelect(t.id).
}
```

`client/src/components/SurfacesPanel.tsx`:

```tsx
import type { Tab } from "../lib/registryStore";

export function SurfacesPanel({
  tabs,
  activeId,
  onSelect,
}: {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 p-2">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Surfaces</h2>
      <ul className="flex flex-col gap-0.5">
        {tabs.map((t) => (
          <li key={t.id}>
            <button
              onClick={() => onSelect(t.id)}
              className={
                t.id === activeId
                  ? "w-full rounded bg-raised px-2 py-1.5 text-left text-sm text-ink border border-line"
                  : "w-full rounded px-2 py-1.5 text-left text-sm text-muted hover:text-ink hover:bg-raised"
              }
            >
              <span className="block truncate">{t.title}</span>
              <span className="block truncate text-xs text-muted">{t.kind}</span>
            </button>
          </li>
        ))}
        {tabs.length === 0 && (
          <li className="px-2 py-4 text-center text-xs text-muted">No surfaces yet.</li>
        )}
      </ul>
    </div>
  );
}
```

`client/src/components/Workspace.tsx` — add the registry state (this is Canvas's current effect, moved):

```tsx
import { reduceRegistry, type Tab } from "../lib/registryStore";
import { openRegistryStream } from "../lib/tauri";
import { SurfacesPanel } from "./SurfacesPanel";
// inside the component:
  const [surfTabs, setSurfTabs] = useState<Tab[]>([]);
  const [activeSurf, setActiveSurf] = useState<string | null>(null);

  useEffect(() => {
    const stop = openRegistryStream(dashboardBase, (snap) => {
      const next = reduceRegistry(snap);
      setSurfTabs(next);
      setActiveSurf((cur) => cur ?? next[0]?.id ?? null);
    });
    return stop;
  }, [dashboardBase]);
```

Replace the surfaces slot with `<SurfacesPanel tabs={surfTabs} activeId={activeSurf} onSelect={setActiveSurf} />` and the Canvas mount with `<Canvas dashboardBase={dashboardBase} tabs={surfTabs} activeId={activeSurf} onSelect={setActiveSurf} />`.

- [ ] **Step 4: Run tests**

Run: `cd client && npm test && npm run typecheck` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Canvas.tsx client/src/components/SurfacesPanel.tsx client/src/components/Workspace.tsx client/test/Canvas.test.tsx client/test/Workspace.test.tsx
git commit -m "feat(client): surfaces panel with registry state lifted to the shell"
```

---

### Task 11: full verification pass

**Files:** none (verification; fix regressions where found).

- [ ] **Step 1: Suites**

Run: `cd agent-host && npm test && npx tsc -p tsconfig.json --noEmit` → PASS.
Run: `cd client && npm run typecheck && npm test && npm run build` → PASS.
Run: `cd client/src-tauri && cargo test` → PASS.

- [ ] **Step 2: Live smoke (needs the operator's hosts on the tailnet)**

Deploy the branch's agent-host to the box (same rsync+build+restart flow as the UI pass; env files untouched), then `npx tauri build --bundles app`, reinstall, and walk: sessions panel lists yesterday's sessions with titles → open one → full history renders → send a turn in it while opening a second tab → background badge appears → new draft tab promotes on first send → rename + archive round-trip → surfaces panel focuses canvas tabs → disconnect. If the live walk cannot run, note it and rely on suites.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "fix: post-verification fixes for shell + sessions"
```
