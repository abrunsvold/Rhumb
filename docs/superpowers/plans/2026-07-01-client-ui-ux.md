# Client UI/UX Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the unstyled Tauri client skeleton into a dark, dense, tool-like desktop app with real chat UX (visible user messages, thinking indicator, Enter-to-send, stick-to-bottom scrolling), slash-command autocomplete, file attachments that land in the agent's workspace, a proper surface canvas, and a disconnect flow.

**Architecture:** Presentation is Tailwind CSS v4 (dark-only design tokens in `@theme`), all inline styles replaced with classes. Two small vertical features cross layers: (1) the agent-host's `session` event gains an optional `slashCommands` list read from the SDK init message; (2) a new upload path: composer → `upload_file` Tauri command → `POST /files` on the agent-host → `<workspace>/uploads/`. Chat is decomposed into `AgentPanel` (stream wiring) + `Transcript` (rendering) + `Composer` (input, autocomplete, attachments).

**Tech Stack:** React 18, TypeScript, Vite 5, Tailwind CSS v4 (`@tailwindcss/vite`), Tauri 2 (Rust: reqwest/serde), Express + Claude Agent SDK (agent-host), vitest + Testing Library + supertest.

**Spec:** `docs/superpowers/specs/2026-07-01-client-ui-design.md`

## Global Constraints

- Dark theme only; no light/system theme.
- Client runtime deps stay exactly `@tauri-apps/api`, `react`, `react-dom`. Tailwind (`tailwindcss`, `@tailwindcss/vite`) is a **devDependency**.
- No CSP changes in `client/src-tauri/tauri.conf.json`.
- Upload limit: 20 MB decoded (`20 * 1024 * 1024` bytes); over-limit → HTTP 413.
- Uploads are stored under `<workspace>/uploads/` with sanitized basenames; traversal-shaped names (`/`, `\`, leading `.`) → HTTP 400.
- No markdown rendering, no upload progress UI, no multipart.
- Keep existing accessible roles/labels: chat textbox + "Send" button, `role="alert"` on connect error, `role="dialog"` on confirmation, `role="tablist"` on canvas tabs, labels "Agent host" / "Dashboard host" / "Control token (optional)".
- Existing test suites must keep passing: `client`, `agent-host` (`npm test` in each), Rust unit tests (`cargo test` in `client/src-tauri`).
- Working directory notes: client commands run in `client/`, host commands in `agent-host/`, Rust in `client/src-tauri/`.
- Repo root: all paths below are relative to the repository root.

---

### Task 1: agent-host — `session` event carries `slashCommands`

**Files:**
- Modify: `agent-host/src/types.ts` (the `AgentEvent` union)
- Modify: `agent-host/src/sessionManager.ts:44-47`
- Test: `agent-host/test/sessionManager.test.ts`

**Interfaces:**
- Consumes: SDK `system`/`init` messages, which may carry `slash_commands: string[]`.
- Produces: `AgentEvent` session variant `{ type: "session"; sessionId: string; slashCommands?: string[] }` — Task 5 mirrors this type on the client.

- [ ] **Step 1: Write the failing test**

Append to `agent-host/test/sessionManager.test.ts` (inside the existing top-level `describe`, matching its existing style of building a `SessionManager` with a scripted `query` — read the file first and reuse its helper if one exists):

```ts
it("includes slashCommands on the session event when the init message reports them", async () => {
  const events: AgentEvent[] = [];
  const manager = new SessionManager({
    query: async function* () {
      yield { type: "system", subtype: "init", session_id: "s1", slash_commands: ["/compact", "/review"] };
      yield { type: "result", result: "done", is_error: false };
    },
    model: "m",
    workspace: "/tmp/w",
  });
  await manager.run("hi", undefined, (e) => events.push(e));
  expect(events[0]).toEqual({ type: "session", sessionId: "s1", slashCommands: ["/compact", "/review"] });
});

it("omits slashCommands when the init message has none", async () => {
  const events: AgentEvent[] = [];
  const manager = new SessionManager({
    query: async function* () {
      yield { type: "system", subtype: "init", session_id: "s2" };
    },
    model: "m",
    workspace: "/tmp/w",
  });
  await manager.run("hi", undefined, (e) => events.push(e));
  expect(events[0]).toEqual({ type: "session", sessionId: "s2" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent-host && npx vitest run test/sessionManager.test.ts`
Expected: FAIL — first new test gets `{ type: "session", sessionId: "s1" }` without `slashCommands`.

- [ ] **Step 3: Implement**

In `agent-host/src/types.ts`, change the session variant of `AgentEvent` to:

```ts
| { type: "session"; sessionId: string; slashCommands?: string[] }
```

In `agent-host/src/sessionManager.ts`, replace the init branch (currently lines 45–47):

```ts
if (message?.type === "system" && message?.subtype === "init") {
  resolvedId = message.session_id;
  const cmds = Array.isArray(message.slash_commands)
    ? message.slash_commands.filter((c: unknown): c is string => typeof c === "string")
    : undefined;
  onEvent(
    cmds && cmds.length > 0
      ? { type: "session", sessionId: resolvedId, slashCommands: cmds }
      : { type: "session", sessionId: resolvedId },
  );
}
```

- [ ] **Step 4: Run the full agent-host suite**

Run: `cd agent-host && npm test`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/types.ts agent-host/src/sessionManager.ts agent-host/test/sessionManager.test.ts
git commit -m "feat(agent-host): report slash commands on the session event"
```

---

### Task 2: agent-host — `POST /files` upload endpoint

**Files:**
- Modify: `agent-host/src/server.ts` (add `workspace` dep + route)
- Modify: `agent-host/src/index.ts:98` (pass workspace)
- Test: `agent-host/test/server.test.ts`

**Interfaces:**
- Consumes: `createServer(deps)`; new optional dep `workspace?: string`.
- Produces: `POST /files` accepting `{ name: string, contentBase64: string }`, responding `200 { path: "uploads/<stored-name>" }`. Task 3's Rust command posts to this route. Route registered only when `workspace` is provided, and sits behind the existing control-token guard.

- [ ] **Step 1: Write the failing tests**

Append to `agent-host/test/server.test.ts`:

```ts
import { mkdtempSync, readFileSync as readFileSyncFs, existsSync as existsSyncFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("POST /files", () => {
  function appWithWorkspace(extra?: { controlToken?: string }) {
    const ws = mkdtempSync(join(tmpdir(), "rhumb-ws-"));
    const app = createServer({ manager: fakeManager([]), workspace: ws, ...extra });
    return { app, ws };
  }
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("writes the file under uploads/ and returns its workspace-relative path", async () => {
    const { app, ws } = appWithWorkspace();
    const res = await request(app).post("/files").send({ name: "report.csv", contentBase64: b64("a,b\n1,2\n") });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: "uploads/report.csv" });
    expect(readFileSyncFs(join(ws, "uploads", "report.csv"), "utf8")).toBe("a,b\n1,2\n");
  });

  it("suffixes on filename collision", async () => {
    const { app, ws } = appWithWorkspace();
    await request(app).post("/files").send({ name: "r.txt", contentBase64: b64("one") });
    const res = await request(app).post("/files").send({ name: "r.txt", contentBase64: b64("two") });
    expect(res.body).toEqual({ path: "uploads/r-2.txt" });
    expect(readFileSyncFs(join(ws, "uploads", "r-2.txt"), "utf8")).toBe("two");
  });

  it("rejects traversal-shaped and missing names with 400", async () => {
    const { app, ws } = appWithWorkspace();
    for (const name of ["../evil.txt", "a/b.txt", "a\\b.txt", ".hidden", ""]) {
      const res = await request(app).post("/files").send({ name, contentBase64: b64("x") });
      expect(res.status).toBe(400);
    }
    expect(existsSyncFs(join(ws, "..", "evil.txt"))).toBe(false);
  });

  it("rejects payloads over 20MB decoded with 413", async () => {
    const { app } = appWithWorkspace();
    const big = Buffer.alloc(20 * 1024 * 1024 + 1, 7).toString("base64");
    const res = await request(app).post("/files").send({ name: "big.bin", contentBase64: big });
    expect(res.status).toBe(413);
  });

  it("is absent when no workspace is configured", async () => {
    const app = createServer({ manager: fakeManager([]) });
    const res = await request(app).post("/files").send({ name: "a.txt", contentBase64: b64("x") });
    expect(res.status).toBe(404);
  });

  it("requires the control token when configured", async () => {
    const { app } = appWithWorkspace({ controlToken: "sekrit" });
    const denied = await request(app).post("/files").send({ name: "a.txt", contentBase64: b64("x") });
    expect(denied.status).toBe(401);
    const ok = await request(app)
      .post("/files")
      .set("Authorization", "Bearer sekrit")
      .send({ name: "a.txt", contentBase64: b64("x") });
    expect(ok.status).toBe(200);
  });
});
```

Note: the existing file already imports `request`, `createServer`, and defines `fakeManager` — reuse them; only add the node imports above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent-host && npx vitest run test/server.test.ts`
Expected: FAIL — 404 for `/files` on every case (route missing) and a TS error for the unknown `workspace` dep.

- [ ] **Step 3: Implement the route**

In `agent-host/src/server.ts`:

Add imports at the top:

```ts
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, parse as parsePath } from "node:path";
```

Extend the deps type:

```ts
export function createServer(deps: {
  manager: ManagerLike;
  turnSubscribers?: Map<string, Set<Response>>;
  controlToken?: string;
  workspace?: string;
}): Express {
```

Change the global JSON parser line to allow big upload bodies only on `/files` (keep the default elsewhere):

```ts
app.use("/files", express.json({ limit: "30mb" }));
app.use(express.json());
```

(`express.json()` skips bodies it has already parsed, so the double mount is safe.)

After the existing `app.post("/messages", …)` block, add:

```ts
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

if (deps.workspace) {
  const workspace = deps.workspace;
  app.post("/files", (req: Request, res: Response) => {
    const { name, contentBase64 } = req.body ?? {};
    if (typeof name !== "string" || typeof contentBase64 !== "string") {
      res.status(400).json({ error: "name and contentBase64 are required" });
      return;
    }
    // Basenames only: no separators, no traversal, no dotfiles.
    if (name.length === 0 || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
      res.status(400).json({ error: "invalid file name" });
      return;
    }
    const bytes = Buffer.from(contentBase64, "base64");
    if (bytes.length > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: "file exceeds 20MB limit" });
      return;
    }
    const dir = join(workspace, "uploads");
    mkdirSync(dir, { recursive: true });
    const { name: stem, ext } = parsePath(name);
    let stored = name;
    for (let n = 2; existsSync(join(dir, stored)); n++) {
      stored = `${stem}-${n}${ext}`;
    }
    writeFileSync(join(dir, stored), bytes);
    res.json({ path: `uploads/${stored}` });
  });
}
```

In `agent-host/src/index.ts` line 98, pass the workspace:

```ts
const app = createServer({ manager, controlToken: deps.config.controlToken, workspace: deps.config.workspace });
```

- [ ] **Step 4: Run the full agent-host suite**

Run: `cd agent-host && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/server.ts agent-host/src/index.ts agent-host/test/server.test.ts
git commit -m "feat(agent-host): POST /files writes uploads into the workspace"
```

---

### Task 3: Rust proxy `upload_file` + client IPC wrapper

**Files:**
- Modify: `client/src-tauri/src/proxy.rs` (new command at end of file)
- Modify: `client/src-tauri/src/lib.rs` (register in `generate_handler!`)
- Modify: `client/src/lib/tauri.ts` (wrapper)

**Interfaces:**
- Consumes: `agent_target()` helper and the persisted-config bearer pattern already in `proxy.rs`; Task 2's `POST /files`.
- Produces: Tauri command `upload_file(agent_base, name, content_base64) -> Result<String, String>` returning the workspace-relative path; TS wrapper `uploadFile(agentBase: string, name: string, contentBase64: string): Promise<string>` — Task 8 calls this.

- [ ] **Step 1: Add the Rust command**

Append to `client/src-tauri/src/proxy.rs`:

```rust
#[tauri::command]
pub async fn upload_file(
    app: tauri::AppHandle,
    agent_base: String,
    name: String,
    content_base64: String,
) -> Result<String, String> {
    let (url, bearer) = agent_target(&app, &agent_base, "/files")?;
    let client = reqwest::Client::new();
    let mut req = client
        .post(&url)
        .json(&serde_json::json!({ "name": name, "contentBase64": content_base64 }));
    if let Some(t) = &bearer {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    v.get("path")
        .and_then(|p| p.as_str())
        .map(str::to_string)
        .ok_or_else(|| "agent host returned a malformed upload response".into())
}
```

- [ ] **Step 2: Register it**

In `client/src-tauri/src/lib.rs`, add `proxy::upload_file,` to the `tauri::generate_handler![...]` list (next to `proxy::send_message`).

- [ ] **Step 3: Verify Rust compiles and unit tests pass**

Run: `cd client/src-tauri && cargo test`
Expected: compiles; existing `utf8_tests` PASS.

- [ ] **Step 4: Add the TS wrapper**

In `client/src/lib/tauri.ts`, after `sendMessage`:

```ts
export function uploadFile(agentBase: string, name: string, contentBase64: string): Promise<string> {
  return invoke<string>("upload_file", { agentBase, name, contentBase64 });
}
```

- [ ] **Step 5: Typecheck the client and commit**

Run: `cd client && npm run typecheck`
Expected: PASS.

```bash
git add client/src-tauri/src/proxy.rs client/src-tauri/src/lib.rs client/src/lib/tauri.ts
git commit -m "feat(client): upload_file proxy command posting to the agent host"
```

---

### Task 4: Tailwind v4 foundation

**Files:**
- Modify: `client/package.json` (devDependencies), `client/vite.config.ts`, `client/src/main.tsx`, `client/index.html`
- Create: `client/src/app.css`

**Interfaces:**
- Produces: design-token utility names used by every later task: colors `bg`, `panel`, `raised`, `border-line`, `ink`, `muted`, `accent`, `accent-soft`, `danger` (used as `bg-bg`, `bg-panel`, `border-line`, `text-ink`, `text-muted`, `bg-accent`, `text-danger`, …).

- [ ] **Step 1: Install**

Run: `cd client && npm install -D tailwindcss @tailwindcss/vite`
Expected: both land in `devDependencies`; `dependencies` unchanged.

- [ ] **Step 2: Wire the Vite plugin**

`client/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    globals: true,
  },
});
```

- [ ] **Step 3: Create the stylesheet**

`client/src/app.css`:

```css
@import "tailwindcss";

@theme {
  --color-bg: #15171c;
  --color-panel: #1b1e24;
  --color-raised: #23272f;
  --color-line: #2e333d;
  --color-ink: #d7dae0;
  --color-muted: #8b919d;
  --color-accent: #4f8cff;
  --color-accent-soft: #1c2c4d;
  --color-danger: #e5484d;
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

@layer base {
  html,
  body,
  #root {
    height: 100%;
  }
  body {
    margin: 0;
    background-color: var(--color-bg);
    color: var(--color-ink);
    font-family: var(--font-sans);
    font-size: 14px;
    overflow: hidden;
  }
}
```

- [ ] **Step 4: Import it**

In `client/src/main.tsx`, add as the first line:

```ts
import "./app.css";
```

- [ ] **Step 5: Verify build and tests**

Run: `cd client && npm run build && npm test`
Expected: build succeeds emitting a CSS asset; all existing tests PASS (jsdom ignores the stylesheet).

- [ ] **Step 6: Commit**

```bash
git add client/package.json client/package-lock.json client/vite.config.ts client/src/app.css client/src/main.tsx client/index.html
git commit -m "feat(client): tailwind v4 foundation with dark design tokens"
```

---

### Task 5: Transcript state — `user` kind, `slashCommands`, `appendUserMessage`

**Files:**
- Modify: `client/src/lib/types.ts`, `client/src/lib/agentEvents.ts`
- Test: `client/test/agentEvents.test.ts`

**Interfaces:**
- Consumes: Task 1's event shape.
- Produces (used by Tasks 6–8):

```ts
interface TranscriptMessage {
  kind: "text" | "result" | "error" | "tool" | "user";
  text: string;
  toolName?: string;
  toolInput?: unknown;
  attachments?: string[]; // display names on user messages
}
interface AgentState { sessionId: string | null; slashCommands: string[]; messages: TranscriptMessage[] }
function appendUserMessage(state: AgentState, text: string, attachments?: string[]): AgentState;
```

- [ ] **Step 1: Write the failing tests**

Append to `client/test/agentEvents.test.ts`:

```ts
import { appendUserMessage } from "../src/lib/agentEvents";

describe("user messages and slash commands", () => {
  it("appendUserMessage appends a user-kind message with attachments", () => {
    const next = appendUserMessage(initialAgentState, "analyze this", ["report.csv"]);
    expect(next.messages).toEqual([
      { kind: "user", text: "analyze this", attachments: ["report.csv"] },
    ]);
  });

  it("session events store slashCommands and keep the previous list when absent", () => {
    let s = reduceAgent(initialAgentState, { type: "session", sessionId: "s1", slashCommands: ["/compact"] });
    expect(s.slashCommands).toEqual(["/compact"]);
    s = reduceAgent(s, { type: "session", sessionId: "s1" });
    expect(s.slashCommands).toEqual(["/compact"]);
  });
});
```

(The file already imports `reduceAgent` and `initialAgentState`; merge imports as needed.)

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/agentEvents.test.ts`
Expected: FAIL — `appendUserMessage` not exported; `slashCommands` missing/TS error.

- [ ] **Step 3: Implement**

`client/src/lib/types.ts` — session variant becomes:

```ts
| { type: "session"; sessionId: string; slashCommands?: string[] }
```

`client/src/lib/agentEvents.ts`:

```ts
export interface TranscriptMessage {
  kind: "text" | "result" | "error" | "tool" | "user";
  text: string;
  toolName?: string;
  toolInput?: unknown;
  attachments?: string[];
}

export interface AgentState {
  sessionId: string | null;
  slashCommands: string[];
  messages: TranscriptMessage[];
}

export const initialAgentState: AgentState = { sessionId: null, slashCommands: [], messages: [] };

export function appendUserMessage(state: AgentState, text: string, attachments?: string[]): AgentState {
  const msg: TranscriptMessage =
    attachments && attachments.length > 0 ? { kind: "user", text, attachments } : { kind: "user", text };
  return { ...state, messages: [...state.messages, msg] };
}
```

and the session case in `reduceAgent`:

```ts
case "session":
  return {
    ...state,
    sessionId: event.sessionId,
    slashCommands: event.slashCommands ?? state.slashCommands,
  };
```

- [ ] **Step 4: Run the client suite**

Run: `cd client && npm test`
Expected: PASS (existing tests unaffected — `initialAgentState` gained a field but no test asserts its exact shape; fix any that do by adding `slashCommands: []`).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/agentEvents.ts client/test/agentEvents.test.ts
git commit -m "feat(client): user transcript messages and slash-command state"
```

---

### Task 6: `Transcript` component — rendering, tool expand, stick-to-bottom, thinking indicator

**Files:**
- Create: `client/src/components/Transcript.tsx`
- Test: `client/test/Transcript.test.tsx`

**Interfaces:**
- Consumes: `TranscriptMessage` from Task 5.
- Produces: `<Transcript messages={TranscriptMessage[]} busy={boolean} />` — Task 8 renders it inside AgentPanel. Scroll container has `data-testid="transcript"`.

- [ ] **Step 1: Write the failing tests**

Create `client/test/Transcript.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Transcript } from "../src/components/Transcript";
import type { TranscriptMessage } from "../src/lib/agentEvents";

describe("Transcript", () => {
  it("shows the empty state when there are no messages", () => {
    render(<Transcript messages={[]} busy={false} />);
    expect(screen.getByText(/send a message to start a session/i)).toBeTruthy();
  });

  it("renders each kind distinctly", () => {
    const messages: TranscriptMessage[] = [
      { kind: "user", text: "hi", attachments: ["a.csv"] },
      { kind: "text", text: "hello back" },
      { kind: "tool", text: "Read", toolName: "Read", toolInput: { path: "x" } },
      { kind: "error", text: "boom" },
      { kind: "result", text: "turn done" },
    ];
    render(<Transcript messages={messages} busy={false} />);
    expect(screen.getByText("hi").closest("[data-kind]")?.getAttribute("data-kind")).toBe("user");
    expect(screen.getByText("a.csv")).toBeTruthy();
    expect(screen.getByText("hello back")).toBeTruthy();
    expect(screen.getByText(/Read/).closest("[data-kind]")?.getAttribute("data-kind")).toBe("tool");
    expect(screen.getByText("boom").closest("[data-kind]")?.getAttribute("data-kind")).toBe("error");
    expect(screen.getByText("turn done")).toBeTruthy();
  });

  it("expands a tool chip to show its input JSON on click", async () => {
    render(
      <Transcript
        messages={[{ kind: "tool", text: "Read", toolName: "Read", toolInput: { path: "/tmp/x" } }]}
        busy={false}
      />,
    );
    expect(screen.queryByText(/"\/tmp\/x"/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Read/ }));
    expect(screen.getByText(/"\/tmp\/x"/)).toBeTruthy();
  });

  it("shows a thinking indicator while busy", () => {
    render(<Transcript messages={[]} busy={true} />);
    expect(screen.getByText(/thinking/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/Transcript.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `client/src/components/Transcript.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { TranscriptMessage } from "../lib/agentEvents";

function ToolChip({ m }: { m: TranscriptMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-kind="tool" className="self-start max-w-full">
      <button
        onClick={() => setOpen((o) => !o)}
        className="font-mono text-xs px-2 py-1 rounded border border-line bg-raised text-muted hover:text-ink"
      >
        🔧 {m.toolName}
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto rounded border border-line bg-raised p-2 font-mono text-xs text-muted">
          {JSON.stringify(m.toolInput ?? null, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Message({ m }: { m: TranscriptMessage }) {
  switch (m.kind) {
    case "user":
      return (
        <div data-kind="user" className="self-end max-w-[85%] rounded-lg bg-accent-soft border border-line px-3 py-2 whitespace-pre-wrap">
          {m.text.startsWith("/") ? (
            <span className="font-mono text-accent">{m.text}</span>
          ) : (
            m.text
          )}
          {m.attachments && m.attachments.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {m.attachments.map((a) => (
                <span key={a} className="font-mono text-xs rounded bg-raised border border-line px-1.5 py-0.5 text-muted">
                  📎 {a}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "tool":
      return <ToolChip m={m} />;
    case "error":
      return (
        <div data-kind="error" className="self-start max-w-[85%] text-danger whitespace-pre-wrap">
          {m.text}
        </div>
      );
    case "result":
      return (
        <div data-kind="result" className="self-stretch flex items-center gap-2 text-xs text-muted">
          <span className="h-px flex-1 bg-line" />
          <span className="max-w-[70%] truncate">{m.text}</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    default:
      return (
        <div data-kind="text" className="self-start max-w-[85%] whitespace-pre-wrap">
          {m.text}
        </div>
      );
  }
}

export function Transcript({ messages, busy }: { messages: TranscriptMessage[]; busy: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="transcript"
      className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2"
    >
      {messages.length === 0 && !busy && (
        <p className="m-auto text-muted">Send a message to start a session.</p>
      )}
      {messages.map((m, i) => (
        <Message key={i} m={m} />
      ))}
      {busy && (
        <div className="self-start text-muted text-xs animate-pulse">thinking…</div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd client && npx vitest run test/Transcript.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Transcript.tsx client/test/Transcript.test.tsx
git commit -m "feat(client): transcript component with kinds, tool expand, autoscroll"
```

---

### Task 7: `Composer` component — Enter-to-send, slash autocomplete, attachment staging

**Files:**
- Create: `client/src/components/Composer.tsx`
- Test: `client/test/Composer.test.tsx`

**Interfaces:**
- Consumes: nothing from other components (pure UI).
- Produces (Task 8 consumes):

```ts
interface StagedFile { name: string; contentBase64: string }
// onSend returns true when the send succeeded; Composer clears itself only then.
<Composer slashCommands={string[]} onSend={(text: string, files: StagedFile[]) => Promise<boolean>} />
```

DOM contract: textarea `role="textbox"`, send button named "Send", attach input `aria-label="Attach files"`, autocomplete popup `role="listbox"` with `role="option"` items, staged chips each have a remove button named `Remove <name>`.

- [ ] **Step 1: Write the failing tests**

Create `client/test/Composer.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "../src/components/Composer";

function setup(over?: Partial<{ slashCommands: string[]; onSend: (t: string, f: { name: string; contentBase64: string }[]) => Promise<boolean> }>) {
  const onSend = over?.onSend ?? vi.fn().mockResolvedValue(true);
  render(<Composer slashCommands={over?.slashCommands ?? []} onSend={onSend} />);
  return { onSend };
}

describe("Composer", () => {
  it("Enter sends and clears; Shift+Enter inserts a newline", async () => {
    const { onSend } = setup();
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "line1{Shift>}{Enter}{/Shift}line2");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(box, "{Enter}");
    expect(onSend).toHaveBeenCalledWith("line1\nline2", []);
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
  });

  it("does not send an empty draft", async () => {
    const { onSend } = setup();
    await userEvent.type(screen.getByRole("textbox"), "{Enter}");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the draft when onSend reports failure", async () => {
    const { } = setup({ onSend: vi.fn().mockResolvedValue(false) });
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "keep me{Enter}");
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("keep me"));
  });

  it("shows prefix-matching slash commands and inserts the selection", async () => {
    setup({ slashCommands: ["/compact", "/review", "/cost"] });
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "/co");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["/compact", "/cost"]);
    await userEvent.click(options[0]);
    expect((box as HTMLTextAreaElement).value).toBe("/compact ");
  });

  it("shows no popup when the command list is empty", async () => {
    setup({ slashCommands: [] });
    await userEvent.type(screen.getByRole("textbox"), "/co");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("stages attached files as removable chips and passes them to onSend", async () => {
    const { onSend } = setup();
    const file = new File(["a,b"], "data.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText(/attach files/i), file);
    expect(await screen.findByText(/data\.csv/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /remove data\.csv/i }));
    expect(screen.queryByText(/data\.csv/)).toBeNull();

    await userEvent.upload(screen.getByLabelText(/attach files/i), file);
    await screen.findByText(/data\.csv/);
    await userEvent.type(screen.getByRole("textbox"), "look{Enter}");
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("look", [
        { name: "data.csv", contentBase64: btoa("a,b") },
      ]),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/Composer.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `client/src/components/Composer.tsx`:

```tsx
import { useRef, useState } from "react";

export interface StagedFile {
  name: string;
  contentBase64: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1)); // strip data:*;base64,
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Composer({
  slashCommands,
  onSend,
}: {
  slashCommands: string[];
  onSend: (text: string, files: StagedFile[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // Popup only while typing the leading command token: "/co", not "/compact now".
  const slashPrefix = /^\/\S*$/.test(draft) ? draft : null;
  const matches =
    slashPrefix !== null ? slashCommands.filter((c) => c.startsWith(slashPrefix)) : [];

  async function submit() {
    const text = draft.trim();
    if ((!text && files.length === 0) || sending) return;
    setSending(true);
    try {
      const ok = await onSend(text, files);
      if (ok) {
        setDraft("");
        setFiles([]);
      }
    } finally {
      setSending(false);
    }
  }

  async function stage(list: FileList | File[]) {
    const staged = await Promise.all(
      Array.from(list).map(async (f) => ({ name: f.name, contentBase64: await fileToBase64(f) })),
    );
    setFiles((prev) => [...prev, ...staged]);
  }

  function pick(cmd: string) {
    setDraft(`${cmd} `);
    boxRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (matches.length > 0 && slashPrefix !== null && slashPrefix.length > 1) {
        pick(matches[0]);
        return;
      }
      void submit();
    } else if (e.key === "Tab" && matches.length > 0) {
      e.preventDefault();
      pick(matches[0]);
    }
  }

  const rows = Math.min(8, Math.max(1, draft.split("\n").length));

  return (
    <div
      className="relative border-t border-line bg-panel p-2 flex flex-col gap-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) void stage(e.dataTransfer.files);
      }}
    >
      {matches.length > 0 && (
        <ul role="listbox" className="absolute bottom-full left-2 mb-1 w-64 rounded border border-line bg-raised shadow-lg overflow-hidden">
          {matches.map((c) => (
            <li key={c}>
              <button
                role="option"
                aria-selected={false}
                onClick={() => pick(c)}
                className="w-full text-left font-mono text-xs px-2 py-1.5 hover:bg-accent-soft"
              >
                {c}
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {files.map((f) => (
            <span key={f.name} className="font-mono text-xs rounded bg-raised border border-line px-1.5 py-0.5 flex items-center gap-1">
              📎 {f.name}
              <button
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                className="text-muted hover:text-danger"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <label className="cursor-pointer rounded border border-line bg-raised px-2 py-1.5 text-muted hover:text-ink">
          📎
          <input
            type="file"
            multiple
            aria-label="Attach files"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void stage(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <textarea
          ref={boxRef}
          rows={rows}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message the agent — / for commands"
          className="flex-1 resize-none rounded border border-line bg-raised px-2 py-1.5 outline-none placeholder:text-muted focus:border-accent"
        />
        <button
          onClick={() => void submit()}
          disabled={sending || (draft.trim().length === 0 && files.length === 0)}
          className="rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd client && npx vitest run test/Composer.test.tsx`
Expected: PASS. (If the Enter-completes-command behavior fights the "Enter sends" test: the test drafts never start with `/` except the autocomplete test, which clicks — behavior is compatible.)

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Composer.tsx client/test/Composer.test.tsx
git commit -m "feat(client): composer with enter-to-send, slash autocomplete, attachments"
```

---

### Task 8: AgentPanel wiring — busy turns, uploads on send, transcript integration

**Files:**
- Modify: `client/src/components/AgentPanel.tsx` (full rewrite below)
- Test: `client/test/AgentPanel.test.tsx` (extend; existing two tests must keep passing)

**Interfaces:**
- Consumes: `Transcript` (Task 6), `Composer`/`StagedFile` (Task 7), `appendUserMessage` (Task 5), `uploadFile` (Task 3), existing `openAgentStream`/`sendMessage`.
- Produces: unchanged external contract `<AgentPanel agentBase={string} />`.

- [ ] **Step 1: Extend the mock and add failing tests**

In `client/test/AgentPanel.test.tsx`, extend the `vi.mock` factory with `uploadFile`:

```ts
vi.mock("../src/lib/tauri", () => ({
  openAgentStream: vi.fn((_base: string, _turnId: string, onEvent: (e: AgentEvent) => void) => {
    capturedOnEvent = onEvent;
    return stopSpy;
  }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn().mockResolvedValue("uploads/data.csv"),
}));
```

and `import { openAgentStream, sendMessage, uploadFile } from "../src/lib/tauri";`. Add tests:

```ts
it("shows the submitted message as a user bubble immediately", async () => {
  render(<AgentPanel agentBase="http://a:8787" />);
  await userEvent.type(screen.getByRole("textbox"), "what is up{Enter}");
  const bubble = await screen.findByText("what is up");
  expect(bubble.closest("[data-kind]")?.getAttribute("data-kind")).toBe("user");
});

it("shows thinking while a turn is open and clears it on result", async () => {
  render(<AgentPanel agentBase="http://a:8787" />);
  await userEvent.type(screen.getByRole("textbox"), "hi{Enter}");
  expect(await screen.findByText(/thinking/i)).toBeTruthy();
  capturedOnEvent?.({ type: "result", result: "done", isError: false });
  await waitFor(() => expect(screen.queryByText(/thinking/i)).toBeNull());
});

it("uploads staged files and appends the attached-files block to the prompt", async () => {
  render(<AgentPanel agentBase="http://a:8787" />);
  const file = new File(["a,b"], "data.csv", { type: "text/csv" });
  await userEvent.upload(screen.getByLabelText(/attach files/i), file);
  await screen.findByText(/data\.csv/);
  await userEvent.type(screen.getByRole("textbox"), "analyze{Enter}");
  await waitFor(() => expect(uploadFile).toHaveBeenCalledWith("http://a:8787", "data.csv", btoa("a,b")));
  await waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith(
      "http://a:8787",
      expect.any(String),
      "analyze\n\n[Attached files: uploads/data.csv]",
      undefined,
    ),
  );
});

it("surfaces an upload failure and keeps the draft", async () => {
  (uploadFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("413"));
  render(<AgentPanel agentBase="http://a:8787" />);
  const file = new File(["a,b"], "data.csv", { type: "text/csv" });
  await userEvent.upload(screen.getByLabelText(/attach files/i), file);
  await screen.findByText(/data\.csv/);
  await userEvent.type(screen.getByRole("textbox"), "analyze{Enter}");
  expect(await screen.findByText(/upload failed/i)).toBeTruthy();
  expect(sendMessage).not.toHaveBeenCalled();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("analyze");
});
```

Add `waitFor` to the testing-library import.

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/AgentPanel.test.tsx`
Expected: new tests FAIL (no user bubble, no thinking, no uploadFile usage). The two pre-existing tests must still pass at the end of this task — note the first one clicks the Send button after typing; that flow is preserved.

- [ ] **Step 3: Rewrite AgentPanel**

`client/src/components/AgentPanel.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { reduceAgent, appendUserMessage, initialAgentState, type AgentState } from "../lib/agentEvents";
import { openAgentStream, sendMessage, uploadFile } from "../lib/tauri";
import { Transcript } from "./Transcript";
import { Composer, type StagedFile } from "./Composer";

export function AgentPanel({ agentBase }: { agentBase: string }) {
  const [state, setState] = useState<AgentState>(initialAgentState);
  const [openTurns, setOpenTurns] = useState(0);
  const stops = useRef<Map<string, () => void>>(new Map());
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = state.sessionId;

  useEffect(() => {
    const map = stops.current;
    return () => {
      for (const stop of map.values()) stop();
      map.clear();
    };
  }, []);

  async function send(text: string, files: StagedFile[]): Promise<boolean> {
    let prompt = text;
    if (files.length > 0) {
      try {
        const paths: string[] = [];
        for (const f of files) paths.push(await uploadFile(agentBase, f.name, f.contentBase64));
        prompt = `${text}\n\n[Attached files: ${paths.join(", ")}]`;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setState((prev) =>
          reduceAgent(prev, { type: "error", message: `Upload failed: ${detail}` }),
        );
        return false;
      }
    }
    setState((prev) => appendUserMessage(prev, text, files.map((f) => f.name)));
    const turnId = crypto.randomUUID();
    setOpenTurns((n) => n + 1);
    const stop = openAgentStream(agentBase, turnId, (event) => {
      setState((prev) => reduceAgent(prev, event));
      if (event.type === "result" || event.type === "error") {
        stops.current.get(turnId)?.();
        stops.current.delete(turnId);
        setOpenTurns((n) => Math.max(0, n - 1));
      }
    });
    stops.current.set(turnId, stop);
    await sendMessage(agentBase, turnId, prompt, sessionRef.current ?? undefined);
    return true;
  }

  return (
    <div className="flex h-full flex-col bg-panel">
      <Transcript messages={state.messages} busy={openTurns > 0} />
      <Composer slashCommands={state.slashCommands} onSend={send} />
    </div>
  );
}
```

- [ ] **Step 4: Run the client suite**

Run: `cd client && npm test`
Expected: PASS — including the two pre-existing AgentPanel tests (stream-before-send ordering is preserved: `openAgentStream` is called before `sendMessage` inside `send`).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/AgentPanel.tsx client/test/AgentPanel.test.tsx
git commit -m "feat(client): chat panel with user bubbles, busy state, and uploads"
```

---

### Task 9: Canvas — tab bar, full-size iframe, empty state

**Files:**
- Modify: `client/src/components/Canvas.tsx`
- Test: `client/test/Canvas.test.tsx` (extend)

**Interfaces:**
- Consumes: existing `openRegistryStream`, `reduceRegistry`, `WebviewWindow` detach (all behavior unchanged).
- Produces: same external contract `<Canvas dashboardBase={string} />`.

- [ ] **Step 1: Add failing tests**

Append to `client/test/Canvas.test.tsx` (reuse its existing mocks for `../src/lib/tauri` and `@tauri-apps/api/webviewWindow` — read the file first and follow its pattern for emitting a registry snapshot):

```ts
it("shows an empty state when the registry has no surfaces", async () => {
  render(<Canvas dashboardBase="http://d:8788" />);
  emitSnapshot({ surfaces: [] }); // use the file's existing captured-callback helper name
  expect(await screen.findByText(/no surfaces yet/i)).toBeTruthy();
});

it("marks the active tab with aria-selected", async () => {
  render(<Canvas dashboardBase="http://d:8788" />);
  emitSnapshot({
    surfaces: [
      { id: "s1", title: "Sales", url: "/surfaces/s1/", kind: "dashboard", created: "", updated: "" },
      { id: "s2", title: "Ops", url: "/surfaces/s2/", kind: "dashboard", created: "", updated: "" },
    ],
  });
  const sales = await screen.findByRole("tab", { name: "Sales" });
  expect(sales.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tab", { name: "Ops" }).getAttribute("aria-selected")).toBe("false");
});
```

If the existing test file exposes the stream callback under a different name, adapt `emitSnapshot` accordingly; do not change the existing tests' assertions.

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/Canvas.test.tsx`
Expected: new tests FAIL (no empty-state text; buttons lack `role="tab"`).

- [ ] **Step 3: Restyle Canvas**

Replace the `return` block of `client/src/components/Canvas.tsx` (logic above it unchanged):

```tsx
return (
  <div className="flex h-full flex-col bg-bg">
    <div role="tablist" className="flex items-center gap-1 overflow-x-auto border-b border-line bg-panel px-2 py-1.5">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          onClick={() => setActiveId(t.id)}
          className={
            t.id === activeId
              ? "shrink-0 rounded px-3 py-1 text-sm bg-raised text-ink border border-line"
              : "shrink-0 rounded px-3 py-1 text-sm text-muted hover:text-ink"
          }
        >
          {t.title}
        </button>
      ))}
      {active && (
        <button
          onClick={detach}
          className="ml-auto shrink-0 rounded px-2 py-1 text-xs text-muted border border-line hover:text-ink"
        >
          Detach ↗
        </button>
      )}
    </div>
    {activeUrl ? (
      <iframe
        title={active!.title}
        src={activeUrl}
        sandbox="allow-scripts allow-same-origin"
        className="h-full w-full flex-1 border-0 bg-white"
      />
    ) : (
      <p className="m-auto max-w-xs text-center text-muted">
        No surfaces yet — the agent will publish dashboards here.
      </p>
    )}
  </div>
);
```

- [ ] **Step 4: Run the suite**

Run: `cd client && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Canvas.tsx client/test/Canvas.test.tsx
git commit -m "feat(client): canvas tab bar, full-size surface iframe, empty state"
```

---

### Task 10: App shell — status bar with disconnect, Workspace split, ConnectionScreen + ConfirmationDialog restyle

**Files:**
- Modify: `client/src/App.tsx`, `client/src/components/Workspace.tsx`, `client/src/components/ConnectionScreen.tsx`, `client/src/components/ConfirmationDialog.tsx`
- Test: `client/test/App.test.tsx` (extend), `client/test/ConnectionScreen.test.tsx` (extend)

**Interfaces:**
- Consumes: existing `setConfig` IPC (empty bases are valid per `valid_base` in `client/src-tauri/src/lib.rs`).
- Produces: `Workspace` gains `onDisconnect: () => void` prop.

- [ ] **Step 1: Add failing tests**

`client/test/App.test.tsx` — read the file first; it already mocks `../src/lib/tauri`. Ensure the mock includes `setConfig: vi.fn().mockResolvedValue(undefined)` and add:

```ts
it("disconnect clears the config and returns to the connection screen", async () => {
  // arrange the existing "configured" mock so Workspace renders
  render(<App />);
  const btn = await screen.findByRole("button", { name: /disconnect/i });
  await userEvent.click(btn);
  expect(setConfig).toHaveBeenCalledWith({ agentBase: "", dashboardBase: "" });
  expect(await screen.findByText(/connect rhumb/i)).toBeTruthy();
});
```

`client/test/ConnectionScreen.test.tsx` — add:

```ts
it("submits with Enter from an input", async () => {
  render(<ConnectionScreen onConnected={onConnected} />);
  await userEvent.type(screen.getByLabelText(/agent host/i), "http://a:8787");
  await userEvent.type(screen.getByLabelText(/dashboard host/i), "http://d:8788{Enter}");
  await waitFor(() => expect(onConnected).toHaveBeenCalled());
});
```

(Adapt setup names to the file's existing helpers/mocks; `checkHealth` is already mocked to resolve `true` in its happy-path test.)

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/App.test.tsx test/ConnectionScreen.test.tsx`
Expected: new tests FAIL (no Disconnect button; Enter does nothing).

- [ ] **Step 3: Implement App + Workspace**

`client/src/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ConnectionScreen } from "./components/ConnectionScreen";
import { Workspace } from "./components/Workspace";
import { ConfirmationDialog } from "./components/ConfirmationDialog";
import { getConfig, setConfig, type AppConfig } from "./lib/tauri";

export function App() {
  const [config, setConfigState] = useState<AppConfig | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getConfig().then((c) => {
      if (c.agentBase && c.dashboardBase) setConfigState(c);
      setLoaded(true);
    });
  }, []);

  async function disconnect() {
    setConfigState(null);
    try {
      await setConfig({ agentBase: "", dashboardBase: "" });
    } catch {
      // state is already reset; nothing actionable
    }
  }

  if (!loaded) return <div className="flex h-full items-center justify-center text-muted">Loading…</div>;
  if (!config) return <ConnectionScreen onConnected={setConfigState} />;
  return (
    <>
      <Workspace agentBase={config.agentBase} dashboardBase={config.dashboardBase} onDisconnect={disconnect} />
      <ConfirmationDialog agentBase={config.agentBase} dashboardBase={config.dashboardBase} />
    </>
  );
}
```

`client/src/components/Workspace.tsx`:

```tsx
import { AgentPanel } from "./AgentPanel";
import { Canvas } from "./Canvas";

export function Workspace({
  agentBase,
  dashboardBase,
  onDisconnect,
}: {
  agentBase: string;
  dashboardBase: string;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-3 py-1.5 text-xs">
        <span className="font-semibold tracking-wide">Rhumb</span>
        <span className="font-mono text-muted truncate">{agentBase}</span>
        <span className="font-mono text-muted truncate">{dashboardBase}</span>
        <button
          onClick={onDisconnect}
          className="ml-auto rounded border border-line px-2 py-0.5 text-muted hover:text-danger hover:border-danger"
        >
          Disconnect
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-64 w-2/5 resize-x overflow-hidden border-r border-line" style={{ maxWidth: "70%" }}>
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

(The one `style` prop is a `max-width` clamp for the native resize handle — Tailwind's `max-w-[70%]` works too; prefer the class: `className="min-w-64 w-2/5 max-w-[70%] resize-x overflow-hidden border-r border-line"` and drop the style prop.)

- [ ] **Step 4: Implement ConnectionScreen**

`client/src/components/ConnectionScreen.tsx` — keep all logic, change the render to a form (Enter submits a form natively):

```tsx
return (
  <div className="flex h-full items-center justify-center">
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
      className="w-96 rounded-lg border border-line bg-panel p-6 flex flex-col gap-3"
    >
      <h1 className="text-lg font-semibold">Connect Rhumb</h1>
      <p className="text-xs text-muted -mt-2">Point the client at your agent and dashboard hosts.</p>
      <label htmlFor="agent" className="text-xs text-muted">Agent host</label>
      <input
        id="agent"
        placeholder="http://localhost:8787"
        value={agentBase}
        onChange={(e) => setAgentBase(e.target.value)}
        className="rounded border border-line bg-raised px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
      />
      <label htmlFor="dash" className="text-xs text-muted">Dashboard host</label>
      <input
        id="dash"
        placeholder="http://localhost:8788"
        value={dashboardBase}
        onChange={(e) => setDashboardBase(e.target.value)}
        className="rounded border border-line bg-raised px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
      />
      <label htmlFor="token" className="text-xs text-muted">Control token (optional)</label>
      <input
        id="token"
        type="password"
        value={controlToken}
        onChange={(e) => setControlToken(e.target.value)}
        className="rounded border border-line bg-raised px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={busy}
        className="mt-1 rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
      >
        {busy ? "Connecting…" : "Connect"}
      </button>
      {error && (
        <p role="alert" className="rounded border border-danger/50 bg-danger/10 px-2 py-1.5 text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  </div>
);
```

- [ ] **Step 5: Implement ConfirmationDialog restyle**

`client/src/components/ConfirmationDialog.tsx` — logic unchanged; replace the returned JSX:

```tsx
return (
  <div role="dialog" aria-label="Confirm action" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
    <div className="w-full max-w-md rounded-lg border border-line bg-panel p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">
          {current.origin === "data" ? `Write to "${current.source}"` : `Infrastructure: ${current.tool}`}
        </h2>
        {queue.length > 1 && (
          <span className="ml-auto rounded-full bg-raised border border-line px-2 py-0.5 text-xs text-muted">
            {queue.length} pending
          </span>
        )}
      </div>
      {current.origin === "data" && <p className="text-xs text-muted">Surface: {current.surfaceId ?? "unknown"}</p>}
      <pre className="max-h-56 overflow-auto rounded border border-line bg-raised p-2 font-mono text-xs">
        {JSON.stringify(current.op, null, 2)}
      </pre>
      {current.origin === "data" && (
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
          Trust this surface
        </label>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={() => decide("deny")} className="rounded border border-line px-3 py-1.5 text-muted hover:text-ink">
          Deny
        </button>
        <button onClick={() => decide("approve")} className="rounded bg-accent px-3 py-1.5 font-medium text-white">
          Approve
        </button>
      </div>
    </div>
  </div>
);
```

- [ ] **Step 6: Run the full client suite**

Run: `cd client && npm test`
Expected: PASS — including pre-existing App/ConnectionScreen/ConfirmationDialog tests.

- [ ] **Step 7: Commit**

```bash
git add client/src/App.tsx client/src/components/Workspace.tsx client/src/components/ConnectionScreen.tsx client/src/components/ConfirmationDialog.tsx client/test/App.test.tsx client/test/ConnectionScreen.test.tsx
git commit -m "feat(client): app shell with disconnect, restyled connect and confirm flows"
```

---

### Task 11: Full verification pass

**Files:** none (verification only; fix regressions where found).

- [ ] **Step 1: Client checks**

Run: `cd client && npm run typecheck && npm test && npm run build`
Expected: all PASS; build emits a hashed CSS asset alongside JS.

- [ ] **Step 2: agent-host checks**

Run: `cd agent-host && npm test && npx tsc -p tsconfig.json --noEmit`
Expected: PASS. (If the package has no `typecheck` script, the raw `tsc` invocation above covers it; skip if `tsconfig` isn't buildable standalone and `npm test` already type-checks via vitest.)

- [ ] **Step 3: Rust checks**

Run: `cd client/src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 4: Manual smoke (requires the operator's hosts)**

Run: `cd client && npm run tauri:dev`
Walk: connect screen (bad host → styled alert; good hosts → workspace) → send a message (user bubble, thinking indicator, streamed reply, tool chips expand) → type `/` after the first turn (autocomplete popup) → attach a small file and send (agent can read `uploads/<name>`) → surfaces tab bar + full-size iframe → Detach opens a window → Disconnect returns to the connect screen. If `tauri dev` cannot run in this environment, note it in the summary and rely on the automated suites.

- [ ] **Step 5: Final commit (only if fixes were needed)**

```bash
git add -A && git commit -m "fix(client): post-verification fixes for the UI pass"
```
