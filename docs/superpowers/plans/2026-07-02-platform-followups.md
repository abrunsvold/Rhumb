# Platform Follow-ups Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the fourteen reviewed follow-ups from the UI pass and shell+sessions phases: session-index backfill, Rust id validation, sessions-panel refresh/error surfacing, and chat polish.

**Architecture:** No new subsystems. One additive host feature (backfill inside `sessions.ts`), defense-in-depth in the Rust proxy, and localized client component/hook changes. Stacked branch `chore/platform-followups` off `feat/shell-sessions`.

**Tech Stack:** unchanged (Node/Express/TS, Tauri 2/Rust, React 18 + Tailwind tokens, vitest/RTL/supertest).

**Spec:** `docs/superpowers/specs/2026-07-02-platform-followups-design.md`

## Global Constraints

- Only Tailwind token classes; keep all existing accessible roles/labels; no new dependencies anywhere.
- Backfill must never throw out of `createSessionService` (wrap disk work defensively) and must skip: non-`.jsonl` files, `agent-*` sidechain files, ids failing `/^[A-Za-z0-9-]{1,64}$/`, ids already indexed, and files with no extractable user text.
- Rust id validation mirrors the host regex exactly: 1–64 chars of `[A-Za-z0-9-]`.
- All suites stay green: `agent-host`, `client` (+ `typecheck`), `cargo test`.
- Repo root paths; host commands in `agent-host/`, client in `client/`, Rust in `client/src-tauri/`.

---

### Task 1: agent-host — session index backfill

**Files:**
- Modify: `agent-host/src/sessions.ts`
- Test: `agent-host/test/sessions.test.ts` (extend)

**Interfaces:**
- Consumes: existing `encodeProjectDir`, `truncateTitle`, `blockToMessages` (module-private; backfill lives in the same file), `SESSION_ID_RE`-equivalent regex.
- Produces: no API change — `createSessionService` now populates the index from disk at construction.

- [ ] **Step 1: Write the failing tests**

Append inside the transcript-reader describe (reuse its `service()` helper and fs imports; note `service()` returns `{ svc, dir }` but backfill runs at construction, so these tests construct the service AFTER writing fixtures — add a local helper):

```ts
describe("index backfill", () => {
  function makeEnv() {
    const dir = mkdtempSync(join(tmpdir(), "rhumb-backfill-"));
    const ws = resolve(join(dir, "ws"));
    const sessDir = join(dir, "projects", encodeProjectDir(ws));
    mkdirSync(sessDir, { recursive: true });
    const build = () =>
      createSessionService({
        indexPath: join(dir, "sessions.json"),
        projectsDir: join(dir, "projects"),
        workspace: ws,
        now: () => "2026-07-02T12:00:00Z",
      });
    return { dir, sessDir, build };
  }
  const userLine = (text: string) =>
    JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "text", text }] } });

  it("adopts on-disk transcripts not in the index, titled from the first user message", () => {
    const { sessDir, build } = makeEnv();
    writeFileSync(join(sessDir, "aaa-111.jsonl"), userLine("fix the printer dashboard"));
    writeFileSync(join(sessDir, "agent-xyz.jsonl"), userLine("sidechain — must be skipped"));
    writeFileSync(join(sessDir, "not-a-transcript.txt"), "nope");
    writeFileSync(join(sessDir, "bbb-222.jsonl"), "{corrupt");
    const svc = build();
    const list = svc.list();
    expect(list.map((s) => s.id)).toEqual(["aaa-111"]);
    expect(list[0].title).toBe("fix the printer dashboard");
    expect(list[0].archived).toBe(false);
  });

  it("does not duplicate already-indexed sessions and persists the backfill", () => {
    const { sessDir, build } = makeEnv();
    writeFileSync(join(sessDir, "ccc-333.jsonl"), userLine("already known"));
    const first = build();
    expect(first.list()).toHaveLength(1);
    first.upsertFromTurn("ccc-333", "already known"); // bump only
    const second = build(); // fresh service over the same index
    expect(second.list()).toHaveLength(1);
  });

  it("survives a missing projects dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "rhumb-backfill-"));
    const svc = createSessionService({
      indexPath: join(dir, "sessions.json"),
      projectsDir: join(dir, "does-not-exist"),
      workspace: join(dir, "ws"),
      now: () => "2026-07-02T12:00:00Z",
    });
    expect(svc.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent-host && npx vitest run test/sessions.test.ts`
Expected: FAIL — backfill tests see empty lists.

- [ ] **Step 3: Implement**

In `agent-host/src/sessions.ts`: extend the fs import with `readdirSync, statSync`; add a module-level id regex if not present (`const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;`); add above the factory:

```ts
function firstUserText(file: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const user = blockToMessages(JSON.parse(line)).find((m) => m.kind === "user");
      if (user) return user.text;
    } catch {
      // corrupt line: keep scanning
    }
  }
  return null;
}
```

Inside `createSessionService`, after `let sessions = load(...)` / `persist` are defined, add and invoke:

```ts
  // Adopt transcripts that predate the index (or were created by other
  // clients) so the panel lists them. Best-effort: any disk problem leaves
  // the index as loaded.
  function backfillFromDisk(): void {
    const dir = join(deps.projectsDir, encodeProjectDir(resolve(deps.workspace)));
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    let added = false;
    for (const name of names) {
      if (!name.endsWith(".jsonl") || name.startsWith("agent-")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!SESSION_ID_RE.test(id)) continue;
      if (sessions.some((s) => s.id === id)) continue;
      const file = join(dir, name);
      const text = firstUserText(file);
      if (text === null || text.length === 0) continue;
      let stamp = deps.now();
      try {
        stamp = statSync(file).mtime.toISOString();
      } catch {
        // keep now()
      }
      const title = truncateTitle(text);
      sessions.push({ id, title, createdAt: stamp, lastActiveAt: stamp, preview: title, archived: false });
      added = true;
    }
    if (added) persist();
  }
  backfillFromDisk();
```

(If `sessions.ts` already declares a session-id regex under another name, reuse it rather than duplicating.)

- [ ] **Step 4: Run suites**

Run: `cd agent-host && npm test && npx tsc -p tsconfig.json --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/sessions.ts agent-host/test/sessions.test.ts
git commit -m "feat(agent-host): backfill the session index from on-disk transcripts"
```

---

### Task 2: Rust session-id validation + repo chores

**Files:**
- Modify: `client/src-tauri/src/proxy.rs`, `.gitignore`, `agent-host/src/types.ts`, `client/src/lib/types.ts`

**Interfaces:** no signature changes; invalid ids now yield `Err("invalid session id")` before any network call.

- [ ] **Step 1: Add the validator + unit test**

In `client/src-tauri/src/proxy.rs`, near `shell_request`:

```rust
// Mirrors the agent-host route validation (/^[A-Za-z0-9-]{1,64}$/) so a
// malformed id never reaches URL construction.
fn valid_session_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
```

At the top of `get_transcript`, `rename_session`, `archive_session`, and `start_session_stream` (before `agent_target`):

```rust
    if !valid_session_id(&session_id) {
        return Err("invalid session id".into());
    }
```

Unit tests alongside the existing `utf8_tests` module:

```rust
#[cfg(test)]
mod session_id_tests {
    use super::valid_session_id;

    #[test]
    fn accepts_uuid_like_ids() {
        assert!(valid_session_id("3ed7a8ac-2e68-4bb8-b1a8-85f252647b34"));
        assert!(valid_session_id("a"));
    }

    #[test]
    fn rejects_traversal_empty_and_overlong() {
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("../etc"));
        assert!(!valid_session_id("a/b"));
        assert!(!valid_session_id("a?x=1"));
        assert!(!valid_session_id(&"a".repeat(65)));
    }
}
```

- [ ] **Step 2: Verify Rust**

Run: `cd client/src-tauri && cargo test` → PASS (new tests included).

- [ ] **Step 3: Chores**

`.gitignore`: append

```
# TypeScript incremental build state
*.tsbuildinfo
```

`agent-host/src/types.ts` — directly above the `AgentEvent` union add:

```ts
// Hand-mirrored in client/src/lib/types.ts (polyglot-by-contract; no shared
// package). Change both together.
```

`client/src/lib/types.ts` — directly above its `AgentEvent` union add:

```ts
// Hand-mirrored in agent-host/src/types.ts (polyglot-by-contract; no shared
// package). Change both together.
```

- [ ] **Step 4: Verify TS + commit**

Run: `cd client && npm run typecheck` and `cd agent-host && npx tsc -p tsconfig.json --noEmit` → PASS.

```bash
git add client/src-tauri/src/proxy.rs .gitignore agent-host/src/types.ts client/src/lib/types.ts
git commit -m "fix(client): validate session ids in the proxy; mirror-comments and tsbuildinfo ignore"
```

---

### Task 3: chat polish — Composer, Transcript, Canvas

**Files:**
- Modify: `client/src/components/Composer.tsx`, `client/src/components/Transcript.tsx`, `client/src/components/Canvas.tsx`
- Test: `client/test/Composer.test.tsx`, `client/test/Transcript.test.tsx`, `client/test/Canvas.test.tsx` (extend)

**Interfaces:** component props unchanged.

- [ ] **Step 1: Write the failing tests**

`client/test/Composer.test.tsx` — append (reuse `setup`):

```tsx
it("shows Sending… while onSend is in flight", async () => {
  let release!: (v: boolean) => void;
  const onSend = vi.fn(() => new Promise<boolean>((r) => (release = r)));
  render(<Composer slashCommands={[]} onSend={onSend} />);
  await userEvent.type(screen.getByRole("textbox"), "hi{Enter}");
  expect(screen.getByRole("button", { name: /sending…/i })).toBeTruthy();
  await act(async () => release(true));
  expect(screen.getByRole("button", { name: /^send$/i })).toBeTruthy();
});

it("rejects files over 20MB at staging with an inline notice", async () => {
  setup();
  const big = new File(["x"], "big.bin");
  Object.defineProperty(big, "size", { value: 20 * 1024 * 1024 + 1 });
  await userEvent.upload(screen.getByLabelText(/attach files/i), big);
  expect(await screen.findByText(/big\.bin is over the 20 MB limit/i)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /remove big\.bin/i })).toBeNull();
});

it("skips an unreadable file with a notice and stages the rest", async () => {
  setup();
  const bad = new File(["x"], "bad.txt");
  const good = new File(["y"], "good.txt");
  const orig = FileReader.prototype.readAsDataURL;
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementationOnce(function (this: FileReader) {
    setTimeout(() => this.onerror?.(new ProgressEvent("error") as any));
  });
  await userEvent.upload(screen.getByLabelText(/attach files/i), [bad, good]);
  expect(await screen.findByText(/bad\.txt could not be read/i)).toBeTruthy();
  expect(await screen.findByText(/good\.txt/)).toBeTruthy();
  FileReader.prototype.readAsDataURL = orig;
});
```

(Import `act` from `@testing-library/react` if not present. If the mockImplementationOnce/`this` pattern fights jsdom, an equivalent stub that fails the first constructed reader is fine — assertion semantics stay.)

`client/test/Transcript.test.tsx` — append:

```tsx
it("mono-styles only the leading slash-command token of a user message", () => {
  render(<Transcript messages={[{ kind: "user", text: "/compact then summarize" }]} busy={false} />);
  const cmd = screen.getByText("/compact");
  expect(cmd.className).toMatch(/font-mono/);
  const bubble = cmd.closest("[data-kind='user']")!;
  expect(bubble.textContent).toBe("/compact then summarize");
});
```

`client/test/Canvas.test.tsx` — the existing `WebviewWindow` mock gains a `once` spy; append:

```tsx
it("surfaces a detach failure inline", async () => {
  // arrange one surface + click Detach (reuse the file's existing setup)
  // capture the 'tauri://error' handler registered via once and invoke it
  // then: expect(await screen.findByText(/detach failed/i)).toBeTruthy();
  // exact wiring follows the file's existing WebviewWindow mock shape — the
  // mock instance must expose once: vi.fn((evt, cb) => { handlers[evt] = cb; })
});
```

Write this test fully against the file's real mock (read it first); the behavioral assertions are: clicking Detach then firing the captured `tauri://error` handler renders text matching `/detach failed/i`, and firing `tauri://created` instead renders nothing.

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/Composer.test.tsx test/Transcript.test.tsx test/Canvas.test.tsx`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

`Composer.tsx`:
- Button content: `{sending ? "Sending…" : "Send"}`.
- Add `const [stageError, setStageError] = useState<string | null>(null);` and a module const `const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;`. Replace `stage`:

```tsx
  async function stage(list: FileList | File[]) {
    const accepted: StagedFile[] = [];
    const problems: string[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_UPLOAD_BYTES) {
        problems.push(`${f.name} is over the 20 MB limit`);
        continue;
      }
      try {
        accepted.push({ name: f.name, contentBase64: await fileToBase64(f) });
      } catch {
        problems.push(`${f.name} could not be read`);
      }
    }
    if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
    setStageError(problems.length > 0 ? problems.join("; ") : null);
  }
```

- Render above the chips row: `{stageError && <p className="text-xs text-danger">{stageError}</p>}`; also `setStageError(null)` alongside the draft/files reset on successful submit.

`Transcript.tsx` — user case, replace the whole-text mono branch:

```tsx
{m.text.startsWith("/") ? (
  (() => {
    const space = m.text.indexOf(" ");
    const cmd = space === -1 ? m.text : m.text.slice(0, space);
    return (
      <>
        <span className="font-mono text-accent">{cmd}</span>
        {space === -1 ? "" : m.text.slice(space)}
      </>
    );
  })()
) : (
  m.text
)}
```

`Canvas.tsx` — add `const [detachError, setDetachError] = useState(false);`; in `detach()` (security comment untouched):

```tsx
    const w = new WebviewWindow(`surface:${active.id}`, { url: activeUrl, title: active.title });
    void w.once("tauri://created", () => setDetachError(false));
    void w.once("tauri://error", () => setDetachError(true));
```

and next to the Detach button: `{detachError && <span className="shrink-0 text-xs text-danger">Detach failed</span>}`.

- [ ] **Step 4: Run the client suite**

Run: `cd client && npm test && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Composer.tsx client/src/components/Transcript.tsx client/src/components/Canvas.tsx client/test/Composer.test.tsx client/test/Transcript.test.tsx client/test/Canvas.test.tsx
git commit -m "fix(client): upload guardrails, sending state, slash-token styling, detach errors"
```

---

### Task 4: sessions surfaces — panel refresh/error, hook cleanup, StrictMode guard, aria

**Files:**
- Modify: `client/src/components/SessionsPanel.tsx`, `client/src/hooks/useChatSessions.ts`, `client/src/components/Workspace.tsx`, `client/src/components/SurfacesPanel.tsx`
- Test: `client/test/SessionsPanel.test.tsx`, `client/test/Workspace.test.tsx` (extend)

**Interfaces:** unchanged.

- [ ] **Step 1: Write the failing tests**

`client/test/SessionsPanel.test.tsx` — append (reuse `setup`; import `waitFor`, and use fake timers only where noted):

```tsx
it("shows an inline error when the list fetch fails and clears it on recovery", async () => {
  (listSessions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("403"));
  setup();
  expect(await screen.findByText(/couldn't load sessions/i)).toBeTruthy();
});

it("refetches when the running-tab count drops", async () => {
  const { rerender } = render(
    <SessionsPanel agentBase="http://a:8787" tabs={[{ key: "s1", openTurns: 1, unread: false }]} onOpen={vi.fn()} onNew={vi.fn()} />,
  );
  await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
  rerender(
    <SessionsPanel agentBase="http://a:8787" tabs={[{ key: "s1", openTurns: 0, unread: false }]} onOpen={vi.fn()} onNew={vi.fn()} />,
  );
  await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
});
```

(The 15 s interval is implementation detail — do not fake-timer-test it; the two behaviors above are the contract.)

`client/test/Workspace.test.tsx` — append:

```tsx
it("opens exactly one draft even if the mount effect double-fires", async () => {
  setup();
  const tabs = await screen.findAllByRole("tab", { name: /new session/i });
  expect(tabs).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run test/SessionsPanel.test.tsx test/Workspace.test.tsx`
Expected: error-state and refetch tests FAIL (the Workspace test may pass already — keep it as a regression pin).

- [ ] **Step 3: Implement**

`SessionsPanel.tsx`:

```tsx
  const [error, setError] = useState(false);

  async function refresh() {
    try {
      setSessions(await listSessions(agentBase));
      setError(false);
    } catch {
      setError(true); // keep the last list; retry via interval
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentBase]);

  const runningCount = tabs.filter((t) => t.openTurns > 0).length;
  const prevRunning = useRef(runningCount);
  useEffect(() => {
    if (runningCount < prevRunning.current) void refresh();
    prevRunning.current = runningCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningCount]);
```

Render under the New session button: `{error && <p className="px-2 text-xs text-danger">Couldn't load sessions — retrying…</p>}`. (Import `useRef`.)

`useChatSessions.ts` — in `close(key)`, alongside the timer cleanup: `retryCount.current.delete(key);`

`Workspace.tsx` — mount effect becomes:

```tsx
  const draftOpened = useRef(false);
  useEffect(() => {
    if (!draftOpened.current && chat.store.tabs.length === 0) {
      draftOpened.current = true;
      chat.newDraft();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

(Import `useRef`.)

`SurfacesPanel.tsx` — the row button gains `aria-current={t.id === activeId ? "true" : undefined}` (valid on buttons, unlike `aria-selected` outside listbox/tab roles). Add a one-line assertion to the existing Workspace surfaces test or SessionsPanel-style unit: the active row has `aria-current="true"`.

- [ ] **Step 4: Run the client suite**

Run: `cd client && npm test && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SessionsPanel.tsx client/src/hooks/useChatSessions.ts client/src/components/Workspace.tsx client/src/components/SurfacesPanel.tsx client/test/SessionsPanel.test.tsx client/test/Workspace.test.tsx
git commit -m "fix(client): sessions panel refresh + error surfacing, mount guard, aria-current"
```

---

### Task 5: verification

- [ ] Run: `cd agent-host && npm test && npx tsc -p tsconfig.json --noEmit` → PASS
- [ ] Run: `cd client && npm run typecheck && npm test && npm run build` → PASS
- [ ] Run: `cd client/src-tauri && cargo test` → PASS
- [ ] Backfill sanity (optional if the box is reachable): deploy agent-host to the serve deploy and confirm `GET /sessions` now lists the pre-index sessions (e.g. yesterday's) with sensible titles.
- [ ] Commit any fixes: `git add -A && git commit -m "fix: post-verification fixes for follow-ups"`
