# Multi-user Rooms (Client) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the room visible in the Tauri client — author labels, a contextual presence/queue strip, @-mention autocomplete, and approval-conflict feedback — and close the last correctness gap from the server slice.

**Architecture:** Two small server additions land first (`turnId` on the `message` event, `roomKey` for draft lanes). The client then keeps its optimistic echo and reconciles the server's broadcast against it by turnId, so attachment chips and instant feedback survive while the server still owns ordering for everyone else. Presentation is last, on top of a state layer that is already correct.

**Tech Stack:** TypeScript (ESM), Express 4, Vitest 2, supertest 7, React 18, @testing-library/react, Tauri v2, Rust/reqwest.

**Spec:** `docs/superpowers/specs/2026-08-05-multi-user-rooms-client-design.md`

## Global Constraints

- Three packages. `agent-host/` uses a `.js` extension on local imports even from `.ts` sources; `client/` does NOT. Follow each package's existing files.
- Tests live in `<package>/test/`. Run with `npx vitest run <file>` from inside the package.
- **Do not modify existing tests to make them pass.** If one goes red, the implementation is wrong. Four tasks name a specific existing test they must change; those are the only exceptions and each says so. Three are prop additions that change no assertion. The fourth is `agentEvents.test.ts`'s "leaves state untouched for message, queue, and presence in plan 1", which **asserts the exact behaviour this plan replaces** — it is superseded by design, not made to pass. Task 4 narrows it and Task 5 deletes it.
- `agent-host/src/types.ts` and `client/src/lib/types.ts` are hand-mirrored by contract. The `AgentEvent` union must stay character-identical between them; Task 13 diffs it.
- `reduceAgent`'s trailing `default` block with `const _exhaustive: never = event` must survive every edit. It is what makes a client older than the host ignore unknown events instead of white-screening the tab.
- `roomKey` is validated server-side against `^draft:[0-9a-f-]{36}$`. **This is security, not hygiene** — an unvalidated client-supplied lane name lets a caller land its turn on another room's lane deliberately. Weakening this regex is a defect.
- The room strip and author labels must be invisible for a solo operator. A single-user client should look exactly as it does today.

---

### Task 1: `turnId` on the broadcast message event

**Files:**
- Modify: `agent-host/src/types.ts`
- Modify: `agent-host/src/server.ts`
- Test: `agent-host/test/server.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `AgentEvent`'s `message` member becomes `{ type: "message"; author: string; text: string; ts: string; turnId?: string }`

- [ ] **Step 1: Write the failing test**

Append to `agent-host/test/server.test.ts`, inside `describe("agent-host server", ...)`:

```ts
  it("carries the turnId on the broadcast message when the post supplied one", async () => {
    const written: string[] = [];
    const fakeRes = { write: (c: string) => written.push(c) } as unknown as import("express").Response;
    const sessionSubscribers = new Map<string, Set<import("express").Response>>();
    sessionSubscribers.set("s1", new Set([fakeRes]));

    const app = createServer({
      manager: fakeManager([]),
      sessionSubscribers,
      identity: { allowedUsers: [], insecureDev: true },
    });

    await request(app).post("/messages").send({ sessionId: "s1", prompt: "hi", turnId: "t-1" });

    const frame = written.find((f) => f.includes('"type":"message"')) ?? "";
    expect(frame).toContain('"turnId":"t-1"');
  });

  it("omits turnId from the broadcast when the post supplied none", async () => {
    const written: string[] = [];
    const fakeRes = { write: (c: string) => written.push(c) } as unknown as import("express").Response;
    const sessionSubscribers = new Map<string, Set<import("express").Response>>();
    sessionSubscribers.set("s1", new Set([fakeRes]));

    const app = createServer({
      manager: fakeManager([]),
      sessionSubscribers,
      identity: { allowedUsers: [], insecureDev: true },
    });

    await request(app).post("/messages").send({ sessionId: "s1", prompt: "hi" });

    const frame = written.find((f) => f.includes('"type":"message"')) ?? "";
    expect(frame).not.toContain("turnId");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/server.test.ts`
Expected: FAIL — the first test's frame has no `turnId`.

- [ ] **Step 3: Write minimal implementation**

In `agent-host/src/types.ts`, extend the `message` member:

```ts
  | { type: "message"; author: string; text: string; ts: string; turnId?: string }
```

In `agent-host/src/server.ts`, find the `message` construction in the `/messages` handler and add the turn id:

```ts
    // The sender receives this on BOTH its turn stream and the session stream.
    // Carrying the turnId lets it recognize its own echo by identity rather
    // than by a text-and-recency guess.
    const message: AgentEvent = {
      type: "message",
      author,
      text: prompt,
      ts: now(),
      ...(turn ? { turnId: turn } : {}),
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npm test`
Expected: PASS — 2 new tests plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/types.ts agent-host/src/server.ts agent-host/test/server.test.ts
git commit -m "feat(agent-host): carry turnId on the broadcast room message"
```

---

### Task 2: `roomKey` for draft lanes

Closes the last known correctness gap from the server slice: two people starting a new chat at the same moment currently share the process-wide `""` lane.

**Files:**
- Modify: `agent-host/src/server.ts`
- Test: `agent-host/test/server.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `POST /messages` accepts an optional `roomKey: string`; the lane becomes `inputId ?? roomKey ?? ""`; a `roomKey` failing `^draft:[0-9a-f-]{36}$` is a 400

- [ ] **Step 1: Write the failing test**

Append to `agent-host/test/server.test.ts`, inside `describe("agent-host server", ...)`:

```ts
  it("gives two different draft room keys separate lanes", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const manager = {
      async run(prompt: string) {
        started.push(prompt);
        await gate;
        return "s-x";
      },
    };
    const app = createServer({ manager, identity: { allowedUsers: [], insecureDev: true } });

    const roomA = "draft:11111111-1111-1111-1111-111111111111";
    const roomB = "draft:22222222-2222-2222-2222-222222222222";
    await request(app).post("/messages").send({ prompt: "one", roomKey: roomA });
    await request(app).post("/messages").send({ prompt: "two", roomKey: roomB });
    await new Promise((r) => setImmediate(r));

    // Distinct rooms drain concurrently; sharing "" would have queued the second.
    expect(started).toHaveLength(2);
    release();
    await new Promise((r) => setImmediate(r));
  });

  it("serializes two turns sent to the same draft room key", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const manager = {
      async run(prompt: string) {
        started.push(prompt);
        if (started.length === 1) await gate;
        return "s-x";
      },
    };
    const app = createServer({ manager, identity: { allowedUsers: [], insecureDev: true } });

    const room = "draft:33333333-3333-3333-3333-333333333333";
    await request(app).post("/messages").send({ prompt: "one", roomKey: room });
    await request(app).post("/messages").send({ prompt: "two", roomKey: room });
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual(["[from: dev@local]\none"]);

    release();
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual(["[from: dev@local]\none", "[from: dev@local]\ntwo"]);
  });

  it("rejects a roomKey outside the draft namespace with 400", async () => {
    const app = createServer({
      manager: fakeManager([]),
      identity: { allowedUsers: [], insecureDev: true },
    });
    // A session-shaped key would let a caller land a turn on another room's lane.
    const res = await request(app)
      .post("/messages")
      .send({ prompt: "hi", roomKey: "s-someone-elses-session" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed draft roomKey with 400", async () => {
    const app = createServer({
      manager: fakeManager([]),
      identity: { allowedUsers: [], insecureDev: true },
    });
    const res = await request(app).post("/messages").send({ prompt: "hi", roomKey: "draft:nope" });
    expect(res.status).toBe(400);
  });

  it("prefers an explicit sessionId over a roomKey", async () => {
    const resumed: Array<string | undefined> = [];
    const manager = {
      async run(_p: string, sessionId: string | undefined) {
        resumed.push(sessionId);
        return sessionId ?? "s-x";
      },
    };
    const app = createServer({ manager, identity: { allowedUsers: [], insecureDev: true } });

    await request(app).post("/messages").send({
      sessionId: "s1",
      prompt: "hi",
      roomKey: "draft:44444444-4444-4444-4444-444444444444",
    });
    await new Promise((r) => setImmediate(r));
    expect(resumed).toEqual(["s1"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/server.test.ts`
Expected: FAIL — `roomKey` is ignored, so the first test sees only one started turn and the 400 tests get 202.

- [ ] **Step 3: Write minimal implementation**

In `agent-host/src/server.ts`, add the pattern next to the other module-level constants:

```ts
// A client may name its own lane ONLY inside the draft namespace. Without this
// guard a caller could send a roomKey equal to another room's live session id,
// land its turn on that lane, and be handed that session to resume by
// `laneSession` — the same cross-room failure roomKey exists to prevent, done
// on purpose instead of by accident.
const DRAFT_ROOM_KEY_RE = /^draft:[0-9a-f-]{36}$/;
```

In the `/messages` handler, add the body field to the destructuring and validate before anything else runs. **Rename it on the way out** — `createServer` already has a `roomKey(lane)` helper in scope, and a plain `roomKey` binding would shadow it and 500 every request:

```ts
    const { sessionId, prompt, turnId, roomKey: requestedRoomKey } = req.body ?? {};
    if (typeof prompt !== "string" || prompt.length === 0) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    // Reject before any queue or broadcast side effect.
    if (
      requestedRoomKey !== undefined &&
      (typeof requestedRoomKey !== "string" || !DRAFT_ROOM_KEY_RE.test(requestedRoomKey))
    ) {
      res.status(400).json({ error: "roomKey must be a draft key" });
      return;
    }
```

Then change the lane derivation:

```ts
    const lane = inputId ?? (typeof requestedRoomKey === "string" ? requestedRoomKey : "");
```

Everything downstream already keys off `lane`; nothing else changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npm test`
Expected: PASS — 5 new tests plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/server.ts agent-host/test/server.test.ts
git commit -m "feat(agent-host): per-draft-room lanes via a validated roomKey"
```

---

### Task 3: Attachment suffix module

The prompt sent to the agent carries attachment paths as a trailing line. The sender builds it; every other client in the room parses it back off an incoming broadcast. Both go through one module so they cannot drift.

**Files:**
- Create: `client/src/lib/attachments.ts`
- Test: `client/test/attachments.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `withAttachments(text: string, paths: string[]): string`, `splitAttachments(prompt: string): { text: string; attachments: string[] }`

- [ ] **Step 1: Write the failing test**

Create `client/test/attachments.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { withAttachments, splitAttachments } from "../src/lib/attachments";

describe("withAttachments", () => {
  it("appends a trailing attachment line", () => {
    expect(withAttachments("look at this", ["/w/uploads/a.png", "/w/uploads/b.txt"])).toBe(
      "look at this\n\n[Attached files: /w/uploads/a.png, /w/uploads/b.txt]",
    );
  });

  it("returns the text unchanged when there are no attachments", () => {
    expect(withAttachments("plain", [])).toBe("plain");
  });
});

describe("splitAttachments", () => {
  it("round-trips what withAttachments builds", () => {
    const paths = ["/w/uploads/a.png", "/w/uploads/b.txt"];
    expect(splitAttachments(withAttachments("look at this", paths))).toEqual({
      text: "look at this",
      attachments: paths,
    });
  });

  it("leaves a prompt with no attachment line alone", () => {
    expect(splitAttachments("just a prompt")).toEqual({ text: "just a prompt", attachments: [] });
  });

  it("ignores an attachment line that is not at the end", () => {
    const s = "a\n\n[Attached files: /w/x.png]\nmore text";
    expect(splitAttachments(s)).toEqual({ text: s, attachments: [] });
  });

  it("preserves a multi-line body", () => {
    const s = withAttachments("one\ntwo", ["/w/x.png"]);
    expect(splitAttachments(s)).toEqual({ text: "one\ntwo", attachments: ["/w/x.png"] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/attachments.test.ts`
Expected: FAIL — cannot resolve `../src/lib/attachments`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/lib/attachments.ts`:

```ts
// The prompt handed to the agent carries uploaded file paths on a trailing
// line so the model can read them. The sender builds that line and every other
// client in the room parses it back off the broadcast, so both directions live
// here — otherwise one person's attachments render as chips and everyone
// else's render as a raw path line in the same transcript.
const SUFFIX_RE = /\n\n\[Attached files: ([^\]\n]+)\]$/;

export function withAttachments(text: string, paths: string[]): string {
  if (paths.length === 0) return text;
  return `${text}\n\n[Attached files: ${paths.join(", ")}]`;
}

export function splitAttachments(prompt: string): { text: string; attachments: string[] } {
  const m = SUFFIX_RE.exec(prompt);
  if (!m) return { text: prompt, attachments: [] };
  return {
    text: prompt.slice(0, m.index),
    attachments: m[1].split(", ").filter(Boolean),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run test/attachments.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/attachments.ts client/test/attachments.test.ts
git commit -m "feat(client): one module for the prompt attachment suffix"
```

---

### Task 4: Presence and queue depth in AgentState

**Files:**
- Modify: `client/src/lib/agentEvents.ts`
- Test: `client/test/agentEvents.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `AgentState` gains `presence: string[]` and `queueDepth: number`, both defaulted in `initialAgentState`; `reduceAgent` handles `presence` and `queue`

- [ ] **Step 1: Write the failing test**

Append to `client/test/agentEvents.test.ts`:

```ts
describe("room state", () => {
  it("starts with nobody present and an empty queue", () => {
    expect(initialAgentState.presence).toEqual([]);
    expect(initialAgentState.queueDepth).toBe(0);
  });

  it("reduces a presence event into per-session state", () => {
    const next = reduceAgent(initialAgentState, {
      type: "presence",
      logins: ["op@example.com", "zoe@example.com"],
    });
    expect(next.presence).toEqual(["op@example.com", "zoe@example.com"]);
  });

  it("reduces a queue event into per-session state", () => {
    const next = reduceAgent(initialAgentState, { type: "queue", depth: 2 });
    expect(next.queueDepth).toBe(2);
  });

  it("leaves messages untouched when reducing room state", () => {
    const seeded = { ...initialAgentState, messages: [{ kind: "text" as const, text: "hi" }] };
    expect(reduceAgent(seeded, { type: "queue", depth: 1 }).messages).toBe(seeded.messages);
  });
});
```

Then narrow the superseded plan-1 test in the same file. `it("leaves state untouched for message, queue, and presence in plan 1", ...)` asserts that all three events are no-ops — which is exactly what this task changes for two of them. Drop its `queue` and `presence` assertions and rename it, leaving only the `message` one (still true until Task 5):

```ts
  it("leaves state untouched for a message event until plan 2 reconciliation lands", () => {
    const state = { ...initialAgentState, messages: [{ kind: "text" as const, text: "hi" }] };
    expect(
      reduceAgent(state, {
        type: "message",
        author: "op@example.com",
        text: "hi",
        ts: "2026-08-04T00:00:00Z",
      }),
    ).toBe(state);
  });
```

This is a permitted, required edit to an existing test — the assertions being removed document behaviour this task deliberately replaces, and no assertion is being weakened to accommodate a bug.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/agentEvents.test.ts`
Expected: FAIL — `presence` and `queueDepth` are not properties of `AgentState`.

- [ ] **Step 3: Write minimal implementation**

In `client/src/lib/agentEvents.ts`, extend the state:

```ts
export interface AgentState {
  sessionId: string | null;
  slashCommands: string[];
  messages: TranscriptMessage[];
  // Room state, per session, fed by the session stream.
  presence: string[];
  queueDepth: number;
}

export const initialAgentState: AgentState = {
  sessionId: null,
  slashCommands: [],
  messages: [],
  presence: [],
  queueDepth: 0,
};
```

Replace the three-case no-op group with the two real cases, leaving `message` in the no-op group for now (Task 5 takes it):

```ts
    case "presence":
      return { ...state, presence: event.logins };
    case "queue":
      return { ...state, queueDepth: event.depth };
    // Task 5 gives `message` real behaviour; until then it stays inert so the
    // switch remains exhaustive.
    case "message":
      return state;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test`
Expected: PASS — 4 new tests plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/agentEvents.ts client/test/agentEvents.test.ts
git commit -m "feat(client): reduce presence and queue depth into session state"
```

---

### Task 5: Reconcile the sender's own message by turnId

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/agentEvents.ts`
- Test: `client/test/agentEvents.test.ts`

**Interfaces:**
- Consumes: `splitAttachments` from Task 3
- Produces: `appendUserMessage(state: AgentState, text: string, attachments?: string[], id?: string): AgentState`; `reduceAgent` upserts `message` events keyed by `turnId`

- [ ] **Step 1: Write the failing test**

Append to `client/test/agentEvents.test.ts`:

```ts
describe("message reconciliation", () => {
  it("reconciles the sender's optimistic entry instead of appending a duplicate", () => {
    const optimistic = appendUserMessage(initialAgentState, "hello", ["a.png"], "turn-1");
    const next = reduceAgent(optimistic, {
      type: "message",
      author: "op@example.com",
      text: "hello\n\n[Attached files: /w/uploads/a.png]",
      ts: "2026-08-05T00:00:00Z",
      turnId: "turn-1",
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].author).toBe("op@example.com");
    // Local text and chips win: the wire text is the prompt, with the paths appended.
    expect(next.messages[0].text).toBe("hello");
    expect(next.messages[0].attachments).toEqual(["a.png"]);
  });

  it("is idempotent when the same message arrives twice", () => {
    const optimistic = appendUserMessage(initialAgentState, "hello", undefined, "turn-1");
    const event = {
      type: "message" as const,
      author: "op@example.com",
      text: "hello",
      ts: "2026-08-05T00:00:00Z",
      turnId: "turn-1",
    };
    const next = reduceAgent(reduceAgent(optimistic, event), event);
    expect(next.messages).toHaveLength(1);
  });

  it("appends a message whose turnId it does not own", () => {
    const next = reduceAgent(initialAgentState, {
      type: "message",
      author: "zoe@example.com",
      text: "what about the poller?",
      ts: "2026-08-05T00:00:00Z",
      turnId: "turn-zoe",
    });
    expect(next.messages).toEqual([
      {
        kind: "user",
        text: "what about the poller?",
        author: "zoe@example.com",
        id: "turn-zoe",
      },
    ]);
  });

  it("renders another person's attachments as chips, not a raw path line", () => {
    const next = reduceAgent(initialAgentState, {
      type: "message",
      author: "zoe@example.com",
      text: "see this\n\n[Attached files: /w/uploads/z.png]",
      ts: "2026-08-05T00:00:00Z",
      turnId: "turn-zoe",
    });
    expect(next.messages[0].text).toBe("see this");
    expect(next.messages[0].attachments).toEqual(["/w/uploads/z.png"]);
  });

  it("appends a message with no turnId", () => {
    const next = reduceAgent(initialAgentState, {
      type: "message",
      author: "zoe@example.com",
      text: "no turn id",
      ts: "2026-08-05T00:00:00Z",
    });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].id).toBeUndefined();
  });
});
```

Then delete the plan-1 holdover Task 4 narrowed — `it("leaves state untouched for a message event until plan 2 reconciliation lands", ...)`. This task is what makes `message` non-inert, so the assertion is now false by design, and the five reconciliation tests above cover the behaviour that replaced it. This is a permitted, required deletion, not a test weakened to accommodate a bug.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/agentEvents.test.ts`
Expected: FAIL — `appendUserMessage` takes no id, and `message` is inert.

- [ ] **Step 3: Write minimal implementation**

In `client/src/lib/types.ts`, mirror the host exactly:

```ts
  | { type: "message"; author: string; text: string; ts: string; turnId?: string }
```

In `client/src/lib/agentEvents.ts`, add the import:

```ts
import { splitAttachments } from "./attachments";
```

Update the `id` doc comment on `TranscriptMessage`, which is now false:

```ts
  // Stable identifier for list rendering. User messages carry the turnId that
  // produced them, which is also what reconciles the sender's optimistic entry
  // against the server's broadcast; agent output carries none, so consumers
  // still fall back to index (`m.id ?? i`).
  id?: string;
```

Give `appendUserMessage` the id:

```ts
export function appendUserMessage(
  state: AgentState,
  text: string,
  attachments?: string[],
  id?: string,
): AgentState {
  const msg: TranscriptMessage = {
    kind: "user",
    text,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(id ? { id } : {}),
  };
  return { ...state, messages: [...state.messages, msg] };
}
```

Replace the inert `case "message"` with the upsert:

```ts
    case "message": {
      // Upsert, not append. The sender receives its own message on both the
      // turn stream and the session stream, and it already rendered an
      // optimistic entry under this turnId.
      const idx = event.turnId
        ? state.messages.findIndex((m) => m.id === event.turnId)
        : -1;
      if (idx !== -1) {
        // Adopt only the author. The wire text is the prompt, which has the
        // attachment paths appended — taking it would replace the sender's
        // chips with a raw path line.
        const messages = state.messages.slice();
        messages[idx] = { ...messages[idx], author: event.author };
        return { ...state, messages };
      }
      const { text, attachments } = splitAttachments(event.text);
      const msg: TranscriptMessage = {
        kind: "user",
        text,
        author: event.author,
        ...(event.turnId ? { id: event.turnId } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      return { ...state, messages: [...state.messages, msg] };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test`
Expected: PASS — 5 new tests plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/agentEvents.ts client/test/agentEvents.test.ts
git commit -m "feat(client): reconcile the sender's own room message by turnId"
```

---

### Task 6: Wire the send path — optimistic id, roomKey, depth reset

**Files:**
- Modify: `client/src/lib/chatStore.ts`
- Modify: `client/src/lib/tauri.ts`
- Modify: `client/src-tauri/src/proxy.rs`
- Modify: `client/src/hooks/useChatSessions.ts`
- Test: `client/test/chatStore.test.ts`

**Interfaces:**
- Consumes: `appendUserMessage(..., id?)` from Task 5, `withAttachments` from Task 3
- Produces: `addUserMessage(s, key, text, attachments?, id?)`, `resetQueueDepth(s, key)`, `sendMessage(agentBase, turnId, prompt, sessionId?, roomKey?)`

- [ ] **Step 1: Write the failing test**

Append to `client/test/chatStore.test.ts`:

```ts
describe("room store helpers", () => {
  it("stamps the turn id onto the optimistic user message", () => {
    const s = openTab(emptyStore, "s1", "t");
    const next = addUserMessage(s, "s1", "hello", ["a.png"], "turn-1");
    expect(next.tabs[0].agent.messages[0]).toEqual({
      kind: "user",
      text: "hello",
      attachments: ["a.png"],
      id: "turn-1",
    });
  });

  it("resets queue depth without touching presence or messages", () => {
    let s = openTab(emptyStore, "s1", "t");
    s = reduceEvent(s, "s1", { type: "queue", depth: 3 });
    s = reduceEvent(s, "s1", { type: "presence", logins: ["op@example.com"] });
    const next = resetQueueDepth(s, "s1");
    expect(next.tabs[0].agent.queueDepth).toBe(0);
    expect(next.tabs[0].agent.presence).toEqual(["op@example.com"]);
  });
});
```

Add `addUserMessage`, `reduceEvent`, and `resetQueueDepth` to the existing import from `../src/lib/chatStore` if any are missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/chatStore.test.ts`
Expected: FAIL — `addUserMessage` ignores a fifth argument and `resetQueueDepth` does not exist.

- [ ] **Step 3: Write minimal implementation**

In `client/src/lib/chatStore.ts`:

```ts
export function addUserMessage(
  s: ChatStore,
  key: string,
  text: string,
  attachments?: string[],
  id?: string,
): ChatStore {
  return mapTab(s, key, (t) => ({ ...t, agent: appendUserMessage(t.agent, text, attachments, id) }));
}

// The server re-broadcasts presence when a subscriber connects but emits depth
// only on change, so a reconnecting client would otherwise show a stale
// "N waiting" forever.
export function resetQueueDepth(s: ChatStore, key: string): ChatStore {
  return mapTab(s, key, (t) => ({ ...t, agent: { ...t.agent, queueDepth: 0 } }));
}
```

In `client/src-tauri/src/proxy.rs`, add the parameter to `send_message` and pass it through:

```rust
pub async fn send_message(
    app: tauri::AppHandle,
    agent_base: String,
    turn_id: String,
    prompt: String,
    session_id: Option<String>,
    room_key: Option<String>,
) -> Result<(), String> {
    let (url, bearer) = agent_target(&app, &agent_base, "/messages")?;
    let mut body = serde_json::json!({ "turnId": turn_id, "prompt": prompt });
    if let Some(sid) = session_id {
        body["sessionId"] = Value::String(sid);
    }
    if let Some(rk) = room_key {
        body["roomKey"] = Value::String(rk);
    }
```

The rest of that function is unchanged.

In `client/src/lib/tauri.ts`:

```ts
export function sendMessage(
  agentBase: string,
  turnId: string,
  prompt: string,
  sessionId?: string,
  roomKey?: string,
): Promise<void> {
  return invoke("send_message", {
    agentBase,
    turnId,
    prompt,
    sessionId: sessionId ?? null,
    roomKey: roomKey ?? null,
  });
}
```

In `client/src/hooks/useChatSessions.ts`, import the new helpers:

```ts
import { withAttachments } from "../lib/attachments";
```

and add `resetQueueDepth` to the existing `../lib/chatStore` import.

In `attachSessionStream`, reset depth as the stream comes up — put it immediately before `const stop = openSessionStream(...)`:

```ts
    setStore((s) => resetQueueDepth(s, sessionId));
```

In `send`, generate the turn id **before** the optimistic append, build the prompt through the shared helper, stamp the id, and pass the room key. Replace the block from `if (files.length > 0)` through the `sendMessage` call:

```ts
    const turnId = crypto.randomUUID();
    let prompt = text;
    if (files.length > 0) {
      try {
        const paths: string[] = [];
        for (const f of files) paths.push(await uploadFile(agentBase, f.name, f.contentBase64));
        prompt = withAttachments(text, paths);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setStore((s) => reduceEvent(s, key, { type: "error", message: `Upload failed: ${detail}` }));
        return false;
      }
    }
    // Optimistic: the message appears immediately with its chips, and the
    // server's broadcast reconciles against this entry by turnId.
    setStore((s) => addUserMessage(s, key, text, files.map((f) => f.name), turnId));

    const tab = storeRef.current.tabs.find((t) => t.key === key);
    const sessionId = tab?.agent.sessionId ?? undefined;
    turnKey.current.set(turnId, key);
    setStore((s) => bumpTurns(s, key, 1));
```

Delete the old `const turnId = crypto.randomUUID();` line that followed the session lookup. Then at the send call:

```ts
      // A draft room names its own lane so two people starting a new chat at
      // the same moment cannot land on one another's.
      //
      // Omit the argument entirely rather than passing `undefined`: existing
      // useChatSessions tests assert the exact call signature, and vitest
      // treats a trailing explicit `undefined` as a different call.
      const roomKey = key.startsWith("draft:") ? key : undefined;
      if (roomKey !== undefined) {
        await sendMessage(agentBase, turnId, prompt, sessionId, roomKey);
      } else {
        await sendMessage(agentBase, turnId, prompt, sessionId);
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test && npm run build`
Expected: PASS — 2 new tests plus every pre-existing test, and a clean typecheck.

Then: `cd client/src-tauri && cargo test`
Expected: PASS, no new failures.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/chatStore.ts client/src/lib/tauri.ts client/src-tauri/src/proxy.rs client/src/hooks/useChatSessions.ts client/test/chatStore.test.ts
git commit -m "feat(client): stamp turn ids on optimistic messages and name draft lanes"
```

---

### Task 7: Roster fetch

**Files:**
- Modify: `client/src-tauri/src/proxy.rs`
- Modify: `client/src-tauri/src/lib.rs`
- Modify: `client/src/lib/tauri.ts`
- Test: none (a thin proxy wrapper with no logic; Task 11 covers its consumer)

**Interfaces:**
- Consumes: nothing
- Produces: `RosterEntry { login: string; handle: string }`; `getRoster(agentBase: string): Promise<RosterEntry[]>`

- [ ] **Step 1: Write the implementation**

This task adds no branching logic, so it has no test of its own — it is a transport wrapper in the same shape as the existing `get_ontology`. Its behaviour is exercised through Task 11's Composer tests, which inject a roster directly.

In `client/src-tauri/src/proxy.rs`, next to `get_ontology`:

```rust
#[tauri::command]
pub async fn get_roster(app: tauri::AppHandle, agent_base: String) -> Result<Value, String> {
    let (url, bearer) = agent_target(&app, &agent_base, "/roster")?;
    let client = reqwest::Client::new();
    let req = shell_request(client.get(&url), &bearer);
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}
```

In `client/src-tauri/src/lib.rs`, register it in `tauri::generate_handler![...]` immediately after `proxy::get_ontology,`:

```rust
            proxy::get_roster,
```

In `client/src/lib/tauri.ts`:

```ts
export interface RosterEntry {
  login: string;
  handle: string;
}

export async function getRoster(agentBase: string): Promise<RosterEntry[]> {
  const r = await invoke<{ roster: RosterEntry[] }>("get_roster", { agentBase });
  return r.roster;
}
```

- [ ] **Step 2: Verify it builds**

Run: `cd client && npm run build`
Expected: clean typecheck.

Then: `cd client/src-tauri && cargo build`
Expected: compiles with no warnings from the new code.

- [ ] **Step 3: Commit**

```bash
git add client/src-tauri/src/proxy.rs client/src-tauri/src/lib.rs client/src/lib/tauri.ts
git commit -m "feat(client): fetch the mention roster from the agent host"
```

---

### Task 8: Surface the approval-conflict body

Both resolve commands currently collapse any non-2xx into a generic string, so the 409 the servers now return is indistinguishable from a failure.

**Files:**
- Modify: `client/src-tauri/src/proxy.rs`
- Modify: `client/src/lib/tauri.ts`
- Test: none (transport only; Task 12 covers the consumer)

**Interfaces:**
- Consumes: nothing
- Produces: `ResolveConflict { error: string; by: string; decision: string }`; `resolvePending(...)` and `resolveInfraPending(...)` return `Promise<ResolveConflict | null>` — `null` on success, the parsed body on 409

- [ ] **Step 1: Write the implementation**

In `client/src-tauri/src/proxy.rs`, in `resolve_pending`, change the return type to `Result<Option<Value>, String>` and replace the status check:

```rust
    let resp = req.send().await.map_err(|e| e.to_string())?;
    // 409 is not a transport failure: someone else decided first, and the body
    // names them. Anything else non-2xx stays an error.
    if resp.status() == reqwest::StatusCode::CONFLICT {
        return resp.json::<Value>().await.map(Some).map_err(|e| e.to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("dashboard host returned {}", resp.status()));
    }
    Ok(None)
```

Apply the identical change to `resolve_infra_pending`, keeping its `agent host returned {}` wording.

In `client/src/lib/tauri.ts`:

```ts
export interface ResolveConflict {
  error: string;
  by: string;
  decision: string;
}

export function resolvePending(
  dashboardBase: string,
  pendingId: string,
  decision: "approve" | "deny",
  trustSurface: boolean,
): Promise<ResolveConflict | null> {
  return invoke<ResolveConflict | null>("resolve_pending", {
    dashboardBase,
    pendingId,
    decision,
    trustSurface,
  });
}

export function resolveInfraPending(
  agentBase: string,
  pendingId: string,
  decision: "approve" | "deny",
): Promise<ResolveConflict | null> {
  return invoke<ResolveConflict | null>("resolve_infra_pending", { agentBase, pendingId, decision });
}
```

- [ ] **Step 2: Verify it builds**

Run: `cd client && npm run build`
Expected: clean typecheck.

Then: `cd client/src-tauri && cargo test`
Expected: PASS, no new failures.

- [ ] **Step 3: Commit**

```bash
git add client/src-tauri/src/proxy.rs client/src/lib/tauri.ts
git commit -m "feat(client): return the approval-conflict body instead of a bare status"
```

---

### Task 9: RoomStrip

**Files:**
- Create: `client/src/components/RoomStrip.tsx`
- Modify: `client/src/components/AgentPanel.tsx`
- Test: `client/test/RoomStrip.test.tsx`

**Interfaces:**
- Consumes: `AgentState.presence` and `AgentState.queueDepth` from Task 4, `RosterEntry` from Task 7
- Produces: `<RoomStrip presence={string[]} queueDepth={number} roster={RosterEntry[]} />`, rendering `null` unless `presence.length > 1 || queueDepth > 0`

- [ ] **Step 1: Write the failing test**

Create `client/test/RoomStrip.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoomStrip } from "../src/components/RoomStrip";

const roster = [
  { login: "op@example.com", handle: "op" },
  { login: "zoe@example.com", handle: "zoe" },
];

describe("RoomStrip", () => {
  it("renders nothing when you are alone and the queue is empty", () => {
    const { container } = render(
      <RoomStrip presence={["op@example.com"]} queueDepth={0} roster={roster} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when nobody is reported present", () => {
    const { container } = render(<RoomStrip presence={[]} queueDepth={0} roster={roster} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names everyone present by handle when someone else is here", () => {
    render(
      <RoomStrip
        presence={["op@example.com", "zoe@example.com"]}
        queueDepth={0}
        roster={roster}
      />,
    );
    expect(screen.getByTestId("room-strip")).toHaveTextContent("op");
    expect(screen.getByTestId("room-strip")).toHaveTextContent("zoe");
  });

  it("falls back to the full login for someone not in the roster", () => {
    render(
      <RoomStrip presence={["op@example.com", "gone@example.com"]} queueDepth={0} roster={roster} />,
    );
    expect(screen.getByTestId("room-strip")).toHaveTextContent("gone@example.com");
  });

  it("shows the queue depth even when you are alone", () => {
    render(<RoomStrip presence={["op@example.com"]} queueDepth={2} roster={roster} />);
    expect(screen.getByTestId("room-strip")).toHaveTextContent("2 waiting");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/RoomStrip.test.tsx`
Expected: FAIL — cannot resolve `../src/components/RoomStrip`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/components/RoomStrip.tsx`:

```tsx
import type { RosterEntry } from "../lib/tauri";

// Contextual by design: a solo operator with an idle queue gets no strip at
// all, so the single-user client looks exactly as it did before rooms existed.
export function RoomStrip({
  presence,
  queueDepth,
  roster,
}: {
  presence: string[];
  queueDepth: number;
  roster: RosterEntry[];
}) {
  if (presence.length <= 1 && queueDepth === 0) return null;

  // A departed teammate is no longer in the allowlist but still belongs in the
  // room's history, so an unknown login renders as itself.
  const label = (login: string) =>
    roster.find((r) => r.login === login)?.handle ?? login;

  return (
    <div
      data-testid="room-strip"
      className="flex items-center gap-2 border-b border-line bg-raised px-3 py-1 text-xs text-muted"
    >
      {presence.length > 1 && <span>{presence.map(label).join(", ")}</span>}
      {queueDepth > 0 && (
        <span className="ml-auto rounded-full border border-line px-2 py-0.5">
          {queueDepth} waiting
        </span>
      )}
    </div>
  );
}
```

In `client/src/components/AgentPanel.tsx`, accept a roster and render the strip above the transcript:

```tsx
import { Transcript } from "./Transcript";
import { Composer, type StagedFile } from "./Composer";
import { RoomStrip } from "./RoomStrip";
import type { TabState } from "../lib/chatStore";
import type { RosterEntry } from "../lib/tauri";

export function AgentPanel({
  tab,
  slashCommands,
  roster,
  onSend,
}: {
  tab: TabState;
  slashCommands: string[];
  roster: RosterEntry[];
  onSend: (text: string, files: StagedFile[]) => Promise<boolean>;
}) {
  return (
    <div className="flex h-full flex-col bg-panel">
      {tab.stale && (
        <div className="border-b border-line bg-raised px-3 py-1 text-xs text-muted">
          Live updates interrupted — reconnecting…
        </div>
      )}
      <RoomStrip
        presence={tab.agent.presence}
        queueDepth={tab.agent.queueDepth}
        roster={roster}
      />
      <Transcript messages={tab.agent.messages} busy={tab.openTurns > 0} />
      <Composer slashCommands={slashCommands} onSend={onSend} />
    </div>
  );
}
```

Two existing test files need adjusting, and both are permitted, required edits of the prop-addition kind — **no assertion changes in either**:

- `client/test/AgentPanel.test.tsx` renders `AgentPanel` directly in three places. Add `roster={[]}` to each. Do not make the prop optional to dodge this: a defaulted `roster` means a caller that forgets it silently gets an empty list, and Task 11's autocomplete would offer nothing with no error.
- `client/test/Workspace.test.tsx` needs a `getRoster` stub added to its existing `../src/lib/tauri` mock, following that file's established pattern, because `Workspace` now fetches on mount. Wrap its `setup()` in `act()` if the new mount-time fetch produces a React `act()` warning — a warning is a finding, and silencing it this way changes no assertion.

In `client/src/components/Workspace.tsx`, fetch the roster once and pass it down. Add to the imports:

```tsx
import { getRoster, type RosterEntry } from "../lib/tauri";
```

Add state and a fetch beside the existing `useState`/`useEffect` calls:

```tsx
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  useEffect(() => {
    getRoster(agentBase).then(setRoster).catch(() => setRoster([]));
  }, [agentBase]);
```

Then add `roster={roster}` to the `<AgentPanel ... />` element.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test && npm run build`
Expected: PASS — 5 new tests plus every pre-existing test, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/RoomStrip.tsx client/src/components/AgentPanel.tsx client/src/components/Workspace.tsx client/test/RoomStrip.test.tsx
git commit -m "feat(client): contextual room strip for presence and queue depth"
```

---

### Task 10: Author labels

**Files:**
- Modify: `client/src/hooks/useChatSessions.ts`
- Modify: `client/src/components/Transcript.tsx`
- Modify: `client/src/components/AgentPanel.tsx`
- Modify: `client/src/components/Workspace.tsx`
- Test: `client/test/Transcript.test.tsx`

**Interfaces:**
- Consumes: `TranscriptMessage.author` (already present), `RosterEntry` from Task 7
- Produces: `useChatSessions` returns `me: string | null`; `<Transcript messages roster me busy />`

**Note on where `me` lives:** the spec says `App.tsx`. It belongs in `Workspace`, which is what actually owns `useChatSessions` and renders `AgentPanel`. The spec has been corrected.

- [ ] **Step 1: Write the failing test**

Append to `client/test/Transcript.test.tsx`:

```tsx
describe("author labels", () => {
  const roster = [
    { login: "op@example.com", handle: "op" },
    { login: "zoe@example.com", handle: "zoe" },
  ];

  it("labels a message from someone else by handle", () => {
    render(
      <Transcript
        messages={[{ kind: "user", text: "hi", author: "zoe@example.com" }]}
        roster={roster}
        me="op@example.com"
        busy={false}
      />,
    );
    expect(screen.getByText("zoe")).toBeInTheDocument();
  });

  it("does not label your own message once you are known", () => {
    render(
      <Transcript
        messages={[{ kind: "user", text: "hi", author: "op@example.com" }]}
        roster={roster}
        me="op@example.com"
        busy={false}
      />,
    );
    expect(screen.queryByText("op")).not.toBeInTheDocument();
  });

  it("labels every authored message before you are known", () => {
    render(
      <Transcript
        messages={[{ kind: "user", text: "hi", author: "op@example.com" }]}
        roster={roster}
        me={null}
        busy={false}
      />,
    );
    expect(screen.getByText("op")).toBeInTheDocument();
  });

  it("labels an author who has left the allowlist by full login", () => {
    render(
      <Transcript
        messages={[{ kind: "user", text: "hi", author: "gone@example.com" }]}
        roster={roster}
        me="op@example.com"
        busy={false}
      />,
    );
    expect(screen.getByText("gone@example.com")).toBeInTheDocument();
  });

  it("does not label a message with no author", () => {
    const { container } = render(
      <Transcript messages={[{ kind: "user", text: "hi" }]} roster={roster} me={null} busy={false} />,
    );
    expect(container.querySelector("[data-testid='author']")).toBeNull();
  });
});
```

Two existing test files need render-argument additions — **the only permitted edits in this task**, and only to satisfy newly-required props. Change no assertion in either:

- `client/test/Transcript.test.tsx` renders `<Transcript ...>` **19 times**; each needs `roster={[]} me={null}`.
- `client/test/AgentPanel.test.tsx` renders `<AgentPanel ...>` **3 times**; each needs `me={null}` (they already gained `roster={[]}` in Task 9).

Keep `me` a **required** prop on both components. Do not default it to `null` to avoid the test edit: the same call was made for `roster` in Task 9, and a required prop turns "a caller forgot to thread `me` through" into a compile error rather than a transcript that silently labels your own messages.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/Transcript.test.tsx`
Expected: FAIL — `Transcript` accepts no `roster` or `me`, and renders no author.

- [ ] **Step 3: Write minimal implementation**

In `client/src/components/Transcript.tsx`, replace the whole `user` case of `Message` with this. The bubble becomes an inner div so the label can sit above it; the outer div keeps `data-kind="user"`, which existing tests query:

```tsx
function Message({ m, label }: { m: TranscriptMessage; label: string | null }) {
  switch (m.kind) {
    case "user":
      return (
        <div data-kind="user" className="self-end max-w-[85%] flex flex-col items-end gap-0.5">
          {label && (
            <span data-testid="author" className="text-xs text-muted">
              {label}
            </span>
          )}
          <div className="rounded-lg bg-accent-soft border border-line px-3 py-2 whitespace-pre-wrap">
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
            {m.attachments && m.attachments.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {m.attachments.map((a) => (
                  <span key={a} className="font-mono text-xs rounded bg-raised border border-line px-1.5 py-0.5 text-muted">
                    {a}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      );
```

The remaining cases (`tool`, `error`, `result`, `default`) are unchanged, but each `<Message />` call site now passes `label`.

Change the component signature and compute the label:

```tsx
export function Transcript({
  messages,
  roster,
  me,
  busy,
}: {
  messages: TranscriptMessage[];
  roster: RosterEntry[];
  me: string | null;
  busy: boolean;
}) {
```

and the map:

```tsx
        {messages.map((m, i) => (
          <Message key={m.id ?? i} m={m} label={authorLabel(m, me, roster)} />
        ))}
```

with this helper above the component:

```tsx
// A solo operator sees no labels once `me` is known. Until then every authored
// message is labelled, because the alternative — labelling nothing — makes
// someone else's message read as your own.
function authorLabel(
  m: TranscriptMessage,
  me: string | null,
  roster: RosterEntry[],
): string | null {
  if (m.kind !== "user" || !m.author) return null;
  if (me !== null && m.author === me) return null;
  return roster.find((r) => r.login === m.author)?.handle ?? m.author;
}
```

Add the type import: `import type { RosterEntry } from "../lib/tauri";`

In `client/src/hooks/useChatSessions.ts`, learn `me` from the first reconciled message. Add state near the other hook state:

```ts
  const [me, setMe] = useState<string | null>(null);
```

and a helper beside `finishTurn`:

```ts
  // A `message` carrying a turnId this client generated is, by definition, our
  // own — so its author is us. One learn per app run, nothing persisted, so it
  // cannot go stale against a changed tailnet login.
  function noteSelfAuthor(ev: AgentEvent) {
    if (ev.type === "message" && ev.turnId && turnKey.current.has(ev.turnId)) {
      setMe((prev) => prev ?? ev.author);
    }
  }
```

Call it in both places an `AgentEvent` is reduced — in `attachSessionStream`, immediately before `setStore((s) => reduceEvent(setStale(...)))`:

```ts
      noteSelfAuthor(ev);
```

and in `send`'s turn-stream handler, immediately before the `if (!hasSessionStream || ...)` block:

```ts
      noteSelfAuthor(event);
```

Add `me` to the hook's return: `return { store, openSession, newDraft, close, focus, send, me };`

In `client/src/components/AgentPanel.tsx`, accept `me: string | null` and pass `roster` and `me` to `<Transcript />`. In `client/src/components/Workspace.tsx`, pass `me={chat.me}` to `<AgentPanel />`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test && npm run build`
Expected: PASS — 5 new tests plus every pre-existing test, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useChatSessions.ts client/src/components/Transcript.tsx client/src/components/AgentPanel.tsx client/src/components/Workspace.tsx client/test/Transcript.test.tsx
git commit -m "feat(client): label room messages from other people"
```

---

### Task 11: @-mention autocomplete

**Files:**
- Modify: `client/src/components/Composer.tsx`
- Modify: `client/src/components/AgentPanel.tsx`
- Test: `client/test/Composer.test.tsx`

**Interfaces:**
- Consumes: `RosterEntry` from Task 7
- Produces: `<Composer slashCommands roster onSend />`

- [ ] **Step 1: Write the failing test**

Append to `client/test/Composer.test.tsx`:

```tsx
describe("mention autocomplete", () => {
  const roster = [
    { login: "op@example.com", handle: "op" },
    { login: "zoe@example.com", handle: "zoe" },
  ];

  function setupMentions() {
    const onSend = vi.fn().mockResolvedValue(true);
    render(<Composer slashCommands={[]} roster={roster} onSend={onSend} />);
    return { onSend };
  }

  it("offers matching handles while typing a mention", async () => {
    setupMentions();
    await userEvent.type(screen.getByRole("textbox"), "ping @z");
    expect(screen.getByRole("option", { name: "zoe" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "op" })).not.toBeInTheDocument();
  });

  it("Enter accepts the top match instead of sending", async () => {
    const { onSend } = setupMentions();
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "ping @z{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe("ping @zoe ");
  });

  it("Tab accepts the top match", async () => {
    setupMentions();
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "ping @z{Tab}");
    expect((box as HTMLTextAreaElement).value).toBe("ping @zoe ");
  });

  it("does not offer mentions when the roster has no match", async () => {
    setupMentions();
    await userEvent.type(screen.getByRole("textbox"), "ping @qq");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("sends normally when the draft has no pending mention", async () => {
    const { onSend } = setupMentions();
    await userEvent.type(screen.getByRole("textbox"), "ping @zoe hello{Enter}");
    expect(onSend).toHaveBeenCalledWith("ping @zoe hello", []);
  });

  it("gives the slash popup precedence over mentions", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(<Composer slashCommands={["/compact"]} roster={roster} onSend={onSend} />);
    // "/@z" satisfies the slash prefix (no spaces) AND the mention regex, so
    // this fails if the slashPrefix guard on mentionMatch is removed.
    await userEvent.type(screen.getByRole("textbox"), "/@z");
    expect(screen.queryByRole("option", { name: "zoe" })).not.toBeInTheDocument();
  });

  it("accepts a mention mid-draft without stacking a space", async () => {
    setupMentions();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(box, "ping @z bye");
    // Walk the caret back to just after the "z", so the accept happens with
    // text still to its right — the arithmetic an end-of-draft test never hits.
    await userEvent.type(box, "{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    await userEvent.keyboard("{Tab}");

    expect(box.value).toBe("ping @zoe bye");
    expect(box.selectionStart).toBe(9);
  });
});
```

`client/test/Composer.test.tsx` renders `<Composer ...>` in **2 places**; each needs `roster={[]}` added. **This is the one permitted edit to existing tests in this task**, and only to satisfy the new required prop — change no assertion.

No other file is affected: the only other render site is `AgentPanel.tsx`, which already receives `roster` as a prop from Task 9, so `AgentPanel`'s own signature and its test file are untouched here. (Verified by enumerating every `<Composer` site before this task was dispatched — four earlier tasks in this plan were tripped up by unenumerated call sites.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/Composer.test.tsx`
Expected: FAIL — `Composer` accepts no `roster` and renders no mention options.

- [ ] **Step 3: Write minimal implementation**

In `client/src/components/Composer.tsx`, add `useEffect` to the React import and `RosterEntry` as a type import, then extend the props:

```tsx
export function Composer({
  slashCommands,
  roster,
  onSend,
}: {
  slashCommands: string[];
  roster: RosterEntry[];
  onSend: (text: string, files: StagedFile[]) => Promise<boolean>;
}) {
```

Add caret tracking and the mention match, immediately after the existing `slashPrefix`/`matches` lines:

```tsx
  const [caret, setCaret] = useState(0);
  const pendingCaret = useRef<number | null>(null);

  // Applied after the value re-renders, so the cursor lands after the inserted
  // handle rather than at the end of the textarea.
  useEffect(() => {
    if (pendingCaret.current !== null && boxRef.current) {
      boxRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [draft]);

  // Mentions can appear anywhere, so match the token before the cursor rather
  // than the whole draft. The slash popup owns the leading token; the two
  // cannot co-occur, since `slashPrefix` rejects anything containing a space.
  const mentionMatch = slashPrefix === null ? /@([A-Za-z0-9._+-]*)$/.exec(draft.slice(0, caret)) : null;
  const mentionPrefix = mentionMatch ? mentionMatch[1] : null;
  const mentionMatches =
    mentionPrefix !== null
      ? roster.filter((r) => r.handle.toLowerCase().startsWith(mentionPrefix.toLowerCase()))
      : [];
```

Add the accept function beside `pick`:

```tsx
  function pickMention(handle: string) {
    const start = caret - (mentionPrefix?.length ?? 0) - 1; // step back over the '@'
    const rest = draft.slice(caret);
    // Don't stack a trailing space onto a remainder that already starts with
    // one — accepting mid-draft would otherwise leave "ping @zoe  bye".
    const sep = rest.startsWith(" ") ? "" : " ";
    setDraft(`${draft.slice(0, start)}@${handle}${sep}${rest}`);
    pendingCaret.current = start + 1 + handle.length + sep.length;
    boxRef.current?.focus();
  }
```

Extend `onKeyDown`:

```tsx
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (matches.length > 0 && slashPrefix !== null && slashPrefix.length > 1) {
        pick(matches[0]);
        return;
      }
      if (mentionMatches.length > 0 && (mentionPrefix?.length ?? 0) > 0) {
        pickMention(mentionMatches[0].handle);
        return;
      }
      void submit();
    } else if (e.key === "Tab" && (matches.length > 0 || mentionMatches.length > 0)) {
      e.preventDefault();
      if (matches.length > 0) pick(matches[0]);
      else pickMention(mentionMatches[0].handle);
    }
  }
```

Track the caret on the textarea by extending its `onChange` and adding selection handlers:

```tsx
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
```

Render a mention popup beside the existing slash popup, immediately after it:

```tsx
      {mentionMatches.length > 0 && (
        <ul role="listbox" className="absolute bottom-full left-2 mb-1 w-64 rounded border border-line bg-raised shadow-lg overflow-hidden">
          {mentionMatches.map((r) => (
            <li key={r.login}>
              <button
                role="option"
                aria-selected={false}
                onClick={() => pickMention(r.handle)}
                className="w-full text-left font-mono text-xs px-2 py-1.5 hover:bg-accent-soft"
              >
                {r.handle}
              </button>
            </li>
          ))}
        </ul>
      )}
```

In `client/src/components/AgentPanel.tsx`, pass `roster={roster}` to `<Composer />`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test && npm run build`
Expected: PASS — 6 new tests plus every pre-existing test, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Composer.tsx client/src/components/AgentPanel.tsx client/test/Composer.test.tsx
git commit -m "feat(client): @-mention autocomplete against the room roster"
```

---

### Task 12: Approval conflicts in the dialog

**Files:**
- Modify: `client/src/components/ConfirmationDialog.tsx`
- Test: `client/test/ConfirmationDialog.test.tsx`

**Interfaces:**
- Consumes: `ResolveConflict | null` from Task 8
- Produces: nothing later tasks depend on

- [ ] **Step 1: Write the failing test**

Append to `client/test/ConfirmationDialog.test.tsx`:

The file already mocks `../src/lib/tauri` at module scope, captures the pending
stream callbacks into `capturedOnPending` / `capturedInfra`, and routes resolves
through `resolveSpy` / `infraResolveSpy`. Reuse all of that — do not add a second
mock. Add `waitFor` to the existing `@testing-library/react` import.

```tsx
describe("ConfirmationDialog (approval conflicts)", () => {
  beforeEach(() => { vi.clearAllMocks(); capturedOnPending = null; capturedInfra = null; });

  it("reports who decided first and drops the item", async () => {
    resolveSpy.mockResolvedValueOnce({ error: "already resolved", by: "zoe@example.com", decision: "executed" });
    render(<ConfirmationDialog agentBase="http://a:8787" dashboardBase="http://d:8788" />);
    capturedOnPending?.({ type: "added", write: { pendingId: "p9", source: "ops", op: { kind: "insert", table: "t" }, surfaceId: "d1" } });
    await screen.findByText(/ops/);

    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(await screen.findByText(/already executed by zoe@example\.com/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("closes silently when the resolve succeeds", async () => {
    resolveSpy.mockResolvedValueOnce(null);
    render(<ConfirmationDialog agentBase="http://a:8787" dashboardBase="http://d:8788" />);
    capturedOnPending?.({ type: "added", write: { pendingId: "p10", source: "ops", op: { kind: "insert", table: "t" }, surfaceId: "d1" } });
    await screen.findByText(/ops/);

    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("names an unknown decider gracefully", async () => {
    resolveSpy.mockResolvedValueOnce({ error: "already resolved", by: "", decision: "" });
    render(<ConfirmationDialog agentBase="http://a:8787" dashboardBase="http://d:8788" />);
    capturedOnPending?.({ type: "added", write: { pendingId: "p11", source: "ops", op: { kind: "insert", table: "t" }, surfaceId: "d1" } });
    await screen.findByText(/ops/);

    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(await screen.findByText(/already resolved by someone else/i)).toBeTruthy();
  });

  it("does not carry a stale conflict notice into a later successful decision", async () => {
    resolveSpy.mockResolvedValueOnce({ error: "already resolved", by: "zoe@example.com", decision: "executed" });
    render(<ConfirmationDialog agentBase="http://a:8787" dashboardBase="http://d:8788" />);
    capturedOnPending?.({ type: "added", write: { pendingId: "p12", source: "ops", op: { kind: "insert", table: "t" }, surfaceId: "d1" } });
    await screen.findByText(/ops/);
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await screen.findByText(/already executed by zoe@example\.com/i);

    // An unrelated later item resolves cleanly. Without the setNotice(null) at
    // the top of decide(), the drained queue resurrects the stale notice and
    // this dialog stays mounted.
    resolveSpy.mockResolvedValueOnce(null);
    capturedOnPending?.({ type: "added", write: { pendingId: "p13", source: "ops", op: { kind: "insert", table: "t" }, surfaceId: "d1" } });
    await screen.findByRole("button", { name: /approve/i });
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/ConfirmationDialog.test.tsx`
Expected: FAIL — the dialog ignores the resolve result, so no conflict text appears.

- [ ] **Step 3: Write minimal implementation**

In `client/src/components/ConfirmationDialog.tsx`, add notice state and use the returned conflict:

```tsx
  const [notice, setNotice] = useState<string | null>(null);
```

```tsx
  async function decide(decision: "approve" | "deny") {
    // Clear any notice left by a previous decision BEFORE resolving this one.
    // Without this, once any conflict has occurred the notice never goes away:
    // a later successful, uncontested approval drains the queue and resurrects
    // the old "already resolved by …" screen, falsely implying it conflicted.
    setNotice(null);
    const conflict =
      current.origin === "data"
        ? await resolvePending(dashboardBase, current.pendingId, decision, decision === "approve" && trust)
        : await resolveInfraPending(agentBase, current.pendingId, decision);
    // Everyone in the room sees the same dialog, so someone else may have
    // decided between this dialog rendering and this click.
    if (conflict) {
      setNotice(`Already ${conflict.decision || "resolved"} by ${conflict.by || "someone else"}`);
    }
    setQueue((p) => p.filter((x) => x.pendingId !== current.pendingId));
    setTrust(false);
  }
```

Replace the early return so a conflict notice survives an emptied queue — otherwise the common case (one pending item, someone else approves it first) closes the dialog and tells you nothing:

```tsx
  const current = queue[0];
  if (!current) {
    if (!notice) return null;
    return (
      <div role="dialog" aria-label="Already resolved" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="w-full max-w-md rounded-lg border border-line bg-panel p-5 flex flex-col gap-3">
          <p className="text-sm text-muted">{notice}</p>
          <div className="flex justify-end">
            <button onClick={() => setNotice(null)} className="rounded border border-line px-3 py-1.5 text-muted hover:text-ink">
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }
```

And render the notice above the heading inside the main dialog body, so it is visible when another item is still queued:

```tsx
        {notice && <p className="text-xs text-muted">{notice}</p>}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test && npm run build`
Expected: PASS — 2 new tests plus every pre-existing test, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ConfirmationDialog.tsx client/test/ConfirmationDialog.test.tsx
git commit -m "feat(client): tell the loser of an approval race who decided"
```

---

### Task 13: Full-suite verification

**Files:** none — verification only.

- [ ] **Step 1: Build and test agent-host**

Run: `cd agent-host && npm run build && npm test`
Expected: build clean; all tests pass (some live-integration tests are expected to be SKIPPED).

- [ ] **Step 2: Build and test dashboard-host**

Run: `cd dashboard-host && npm run build && npm test`
Expected: build clean; all tests pass.

- [ ] **Step 3: Test and typecheck the client**

Run: `cd client && npm test && npm run build`
Expected: all tests pass, clean typecheck.

- [ ] **Step 4: Build and test the Rust core**

Run: `cd client/src-tauri && cargo test && cargo build`
Expected: passes and compiles, with no warnings from code this plan touched.

- [ ] **Step 5: Confirm the mirrored contract still matches**

Run: `diff <(sed -n '/export type AgentEvent/,/presence/p' agent-host/src/types.ts) <(sed -n '/export type AgentEvent/,/presence/p' client/src/lib/types.ts)`
Expected: no output. If the union bodies differ, fix the client to match the host.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "test: verify the multi-user rooms client slice builds and passes green"
```

---

## Deferred (from the spec)

- Mention notifications
- Display names beyond `RHUMB_ALLOWED_USERS` handles
- `queueDepth` for draft rooms, if drafts ever gain a session stream
- Normalizing the approval-conflict `decision` vocabulary between the two hosts (chip `task_effa50c3`) — this plan renders whatever each host reports
