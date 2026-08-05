# Multi-user Rooms (Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a Rhumb session into a shared room — several people send attributed turns to one agent, turns are serialized through a per-session queue, and everyone watching sees every message, the queue depth, and who is present.

**Architecture:** No new objects and no new persistence. A session *is* a room. The author is derived server-side from the unforgeable `Tailscale-User-Login` header and stamped into the prompt as a `[from: …]` envelope, so attribution lands in Claude Code's own JSONL transcript and replays for free. A per-session FIFO queue serializes turns with always-accept semantics. Presence and approval actors ride the same header.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Express 4, Vitest 2, supertest 7, Node 20+.

**Spec:** `docs/superpowers/specs/2026-08-04-multi-user-rooms-design.md`

## Global Constraints

- This is **plan 1 of 2**. It is server-side only. Client rendering, @ autocomplete, and the queue-depth indicator are plan 2. Task 12 adds client *types* only, because `AgentEvent` is hand-mirrored across packages by contract.
- **One deviation from the spec's plan split, deliberate:** the spec assigns `AuditEntry.actor` (dashboard-host) to plan 1's sibling. It is folded in here (Task 11) because it is server-side, shares the header-derivation pattern, and has no client dependency.
- Tests live in `<package>/test/*.test.ts`. Run with `npm test` from the package directory (`vitest run`).
- Imports of local modules use the `.js` extension even from `.ts` sources. Follow the existing files exactly.
- `agent-host/src/types.ts` and `client/src/lib/types.ts` are hand-mirrored; both file headers say to change them together. Task 12 discharges this.
- **Do not modify existing tests to make them pass.** If an existing test fails, the implementation is wrong. The one allowed exception is noted inline in Task 7.
- Author strings are lowercased and trimmed, matching `createIdentityGuard`'s comparison.
- The dev-mode author sentinel is exactly `dev@local`.

---

### Task 1: Prompt envelope module

The `[from: …]` envelope is the whole attribution mechanism, and it is a pure string transform. Build it first and alone so every later task can rely on it.

**Files:**
- Create: `agent-host/src/envelope.ts`
- Test: `agent-host/test/envelope.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `stampAuthor(author: string, text: string): string`, `parseEnvelope(text: string): { author: string | null; text: string }`

- [ ] **Step 1: Write the failing test**

Create `agent-host/test/envelope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { stampAuthor, parseEnvelope } from "../src/envelope.js";

describe("stampAuthor", () => {
  it("prefixes a from-line above the body", () => {
    expect(stampAuthor("op@example.com", "hi")).toBe("[from: op@example.com]\nhi");
  });
});

describe("parseEnvelope", () => {
  it("round-trips a stamped message", () => {
    const stamped = stampAuthor("op@example.com", "what is up");
    expect(parseEnvelope(stamped)).toEqual({ author: "op@example.com", text: "what is up" });
  });

  it("preserves a multi-line body", () => {
    const stamped = stampAuthor("op@example.com", "line one\nline two");
    expect(parseEnvelope(stamped)).toEqual({ author: "op@example.com", text: "line one\nline two" });
  });

  it("round-trips an empty body", () => {
    expect(parseEnvelope(stampAuthor("op@example.com", ""))).toEqual({
      author: "op@example.com",
      text: "",
    });
  });

  it("returns unenvelope text unchanged with a null author", () => {
    expect(parseEnvelope("just a prompt")).toEqual({ author: null, text: "just a prompt" });
  });

  it("does not match a from-line with no body separator", () => {
    expect(parseEnvelope("[from: op@example.com]")).toEqual({
      author: null,
      text: "[from: op@example.com]",
    });
  });

  it("does not match a from-line that is not first", () => {
    expect(parseEnvelope("hello\n[from: op@example.com]\nbye")).toEqual({
      author: null,
      text: "hello\n[from: op@example.com]\nbye",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/envelope.test.ts`
Expected: FAIL — cannot resolve `../src/envelope.js`.

- [ ] **Step 3: Write minimal implementation**

Create `agent-host/src/envelope.ts`:

```ts
// Every turn handed to the backend is prefixed with the sender's login, so
// attribution lands in Claude Code's own JSONL transcript and replays without
// a second store. See docs/superpowers/specs/2026-08-04-multi-user-rooms-design.md.
//
// Live attribution is unforgeable (the login is header-derived, and `tailscale
// serve` strips caller-supplied Tailscale-* headers). REPLAYED attribution is
// best-effort: a user can type a fake first line and mislabel themselves in the
// log. That is accepted for a trusted shared-desk room; the alternative is a
// second store that can disagree with the transcript.
const ENVELOPE_RE = /^\[from: ([^\]\n]+)\]\n([\s\S]*)$/;

export function stampAuthor(author: string, text: string): string {
  return `[from: ${author}]\n${text}`;
}

export function parseEnvelope(text: string): { author: string | null; text: string } {
  const m = ENVELOPE_RE.exec(text);
  if (!m) return { author: null, text };
  return { author: m[1], text: m[2] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npx vitest run test/envelope.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/envelope.ts agent-host/test/envelope.test.ts
git commit -m "feat(agent-host): prompt envelope carrying turn authorship"
```

---

### Task 2: Actor header reader

**Files:**
- Modify: `agent-host/src/identity.ts`
- Test: `agent-host/test/identity.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `DEV_ACTOR: "dev@local"`, `readActorLogin(req: { get(name: string): string | undefined }, insecureDev: boolean): string`

- [ ] **Step 1: Write the failing test**

Append to `agent-host/test/identity.test.ts`:

```ts
describe("readActorLogin", () => {
  const reqWith = (login?: string) => ({
    get: (name: string) =>
      name.toLowerCase() === "tailscale-user-login" ? login : undefined,
  });

  it("returns the header login, lowercased and trimmed", () => {
    expect(readActorLogin(reqWith("  Op@Example.com "), false)).toBe("op@example.com");
  });

  it("falls back to the dev sentinel when there is no header in dev mode", () => {
    expect(readActorLogin(reqWith(undefined), true)).toBe(DEV_ACTOR);
    expect(DEV_ACTOR).toBe("dev@local");
  });

  it("returns empty when there is no header in identity mode", () => {
    // Unreachable in practice — createIdentityGuard 403s first — but the
    // reader must not invent an identity if it is ever called out of order.
    expect(readActorLogin(reqWith(undefined), false)).toBe("");
  });

  it("prefers a real header over the dev sentinel", () => {
    expect(readActorLogin(reqWith("op@example.com"), true)).toBe("op@example.com");
  });
});
```

Add `readActorLogin, DEV_ACTOR` to the existing import from `../src/identity.js` at the top of that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/identity.test.ts`
Expected: FAIL — `readActorLogin` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `agent-host/src/identity.ts`:

```ts
// In dev mode there is no `tailscale serve` and therefore no identity header,
// but a room still needs an author for every turn. One fixed sentinel is
// clearer than a per-request guess.
export const DEV_ACTOR = "dev@local";

// Derives who is acting from the same header `createIdentityGuard` authenticates
// against, which is why it cannot be forged: serve injects it and strips any
// caller-supplied Tailscale-* headers. Callers never accept an author from the
// request body.
export function readActorLogin(
  req: { get(name: string): string | undefined },
  insecureDev: boolean,
): string {
  const login = req.get("tailscale-user-login")?.trim().toLowerCase() ?? "";
  if (login) return login;
  return insecureDev ? DEV_ACTOR : "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npx vitest run test/identity.test.ts`
Expected: PASS, all pre-existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/identity.ts agent-host/test/identity.test.ts
git commit -m "feat(agent-host): derive the acting login from the identity header"
```

---

### Task 3: Tell the agent it is in a room

**Files:**
- Modify: `agent-host/src/prompt.ts`
- Test: `agent-host/test/prompt.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: nothing new — `RHUMB_PROMPT_APPEND` gains two lines

- [ ] **Step 1: Write the failing test**

Append to `agent-host/test/prompt.test.ts`, inside the existing `describe("RHUMB_PROMPT_APPEND", ...)` block:

```ts
  it("explains that a session is a shared room with attributed turns", () => {
    expect(RHUMB_PROMPT_APPEND).toContain("shared room");
    expect(RHUMB_PROMPT_APPEND).toContain("[from:");
  });

  it("tells the agent how to handle a turn that mentions another person", () => {
    expect(RHUMB_PROMPT_APPEND).toMatch(/mention/i);
    expect(RHUMB_PROMPT_APPEND).toMatch(/addressed/i);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/prompt.test.ts`
Expected: FAIL — the string does not contain "shared room".

- [ ] **Step 3: Write minimal implementation**

In `agent-host/src/prompt.ts`, add these two entries to the `RHUMB_PROMPT_APPEND` array, immediately after the existing line that begins `"Sessions are driven headlessly"`:

```ts
  "A session is a shared room: several people may be present, and every turn you receive begins with a [from: <login>] line naming its sender. Address people by name when it helps.",
  "A turn may @-mention another person in the room. Answer it yourself only if you are addressed or the question is clearly for you; otherwise reply briefly and leave it for the person named.",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npx vitest run test/prompt.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/prompt.ts agent-host/test/prompt.test.ts
git commit -m "feat(agent-host): teach the agent that sessions are shared rooms"
```

---

### Task 4: Transcript attribution

Strips the envelope back off on read, so history and late-joiner replay carry authors. Every transcript written before this change must still replay — unattributed, not broken.

**Files:**
- Modify: `agent-host/src/types.ts` (add `author?` to `TranscriptMessage`)
- Modify: `agent-host/src/sessions.ts`
- Test: `agent-host/test/sessions.test.ts`

**Interfaces:**
- Consumes: `parseEnvelope` from Task 1
- Produces: `TranscriptMessage.author?: string`

- [ ] **Step 1: Write the failing test**

Append to `agent-host/test/sessions.test.ts`:

```ts
describe("transcript attribution", () => {
  function withTranscript(lines: unknown[]) {
    const dir = mkdtempSync(join(tmpdir(), "rhumb-attr-"));
    const workspace = join(dir, "ws");
    const projectsDir = join(dir, "projects");
    const sessionDir = join(projectsDir, encodeProjectDir(resolve(workspace)));
    mkdirSyncFs(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "s1.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n"),
    );
    const svc = createSessionService({
      indexPath: join(dir, "sessions.json"),
      projectsDir,
      workspace,
      now: () => "2026-08-04T00:00:00Z",
    });
    return svc;
  }

  const userLine = (text: string) => ({ type: "user", message: { content: text } });

  it("lifts the envelope author out of a user message and strips it from the text", () => {
    const svc = withTranscript([userLine("[from: op@example.com]\nwhat is up")]);
    expect(svc.readTranscript("s1")).toEqual([
      { kind: "user", text: "what is up", author: "op@example.com" },
    ]);
  });

  it("replays a pre-envelope transcript unattributed", () => {
    const svc = withTranscript([userLine("plain old prompt")]);
    expect(svc.readTranscript("s1")).toEqual([{ kind: "user", text: "plain old prompt" }]);
  });

  it("strips the envelope from user text blocks in array content", () => {
    const svc = withTranscript([
      { type: "user", message: { content: [{ type: "text", text: "[from: a@b.com]\nhi" }] } },
    ]);
    expect(svc.readTranscript("s1")).toEqual([{ kind: "user", text: "hi", author: "a@b.com" }]);
  });

  it("titles a backfilled session from the stripped text, never the login", () => {
    const svc = withTranscript([userLine("[from: op@example.com]\nfix the header")]);
    const [s] = svc.list();
    expect(s.title).toBe("fix the header");
    expect(s.preview).toBe("fix the header");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/sessions.test.ts`
Expected: FAIL — the first test returns `text: "[from: op@example.com]\nwhat is up"` with no `author`.

- [ ] **Step 3: Write minimal implementation**

In `agent-host/src/types.ts`, add `author` to `TranscriptMessage`:

```ts
export interface TranscriptMessage {
  kind: "text" | "result" | "error" | "tool" | "user";
  text: string;
  toolName?: string;
  toolInput?: unknown;
  // Sender login, recovered from the `[from: ...]` envelope on user turns.
  // Absent for agent output and for transcripts written before rooms existed.
  author?: string;
}
```

In `agent-host/src/sessions.ts`, add the import:

```ts
import { parseEnvelope } from "./envelope.js";
```

Add this helper above `blockToMessages`:

```ts
// User turns arrive enveloped with their sender; agent output never is.
function userMessage(text: string): TranscriptMessage {
  const { author, text: body } = parseEnvelope(text);
  return author ? { kind: "user", text: body, author } : { kind: "user", text: body };
}
```

In `blockToMessages`, replace the string-content user push:

```ts
    if (type === "user" && content.length > 0) out.push(userMessage(content));
```

and replace the array-content text push with a branch:

```ts
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      out.push(type === "user" ? userMessage(b.text) : { kind: "text", text: b.text });
    } else if (type === "assistant" && b.type === "tool_use" && typeof b.name === "string") {
```

`firstUserText` returns `user.text`, which is now already stripped, so backfilled titles need no further change.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npm test`
Expected: PASS — the new tests plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/types.ts agent-host/src/sessions.ts agent-host/test/sessions.test.ts
git commit -m "feat(agent-host): recover turn authorship from the transcript envelope"
```

---

### Task 5: Turn queue

Standalone and pure — no Express, no SSE. This is the only genuinely new machinery in the plan, so it gets built and tested in isolation before anything wires it up.

**Files:**
- Create: `agent-host/src/queue.ts`
- Test: `agent-host/test/queue.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `createTurnQueue(deps: { onDepth: (key: string, depth: number) => void }): TurnQueue`
  - `TurnQueue.enqueue(key: string, run: () => Promise<void>): number`
  - `TurnQueue.rekey(from: string, to: string): void`
  - `TurnQueue.depth(key: string): number`
  - Depth is `waiting + (running ? 1 : 0)` and reaches `0` exactly once per drained lane.

- [ ] **Step 1: Write the failing test**

Create `agent-host/test/queue.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createTurnQueue } from "../src/queue.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("createTurnQueue", () => {
  it("runs one turn at a time per lane, in arrival order", async () => {
    const started: number[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const q = createTurnQueue({ onDepth: () => {} });

    for (let i = 0; i < 3; i++) {
      q.enqueue("s1", async () => {
        started.push(i);
        await gates[i].promise;
      });
    }
    await flush();
    expect(started).toEqual([0]);

    // Resolve out of order: the lane must still advance strictly in order.
    gates[0].resolve();
    await flush();
    expect(started).toEqual([0, 1]);

    gates[1].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates[2].resolve();
    await flush();
    expect(q.depth("s1")).toBe(0);
  });

  it("advances the lane when a turn throws", async () => {
    const started: string[] = [];
    const q = createTurnQueue({ onDepth: () => {} });

    q.enqueue("s1", async () => {
      started.push("boom");
      throw new Error("turn failed");
    });
    q.enqueue("s1", async () => {
      started.push("after");
    });

    await flush();
    expect(started).toEqual(["boom", "after"]);
    expect(q.depth("s1")).toBe(0);
  });

  it("drains different lanes concurrently", async () => {
    const started: string[] = [];
    const a = deferred();
    const b = deferred();
    const q = createTurnQueue({ onDepth: () => {} });

    q.enqueue("s1", async () => {
      started.push("s1");
      await a.promise;
    });
    q.enqueue("s2", async () => {
      started.push("s2");
      await b.promise;
    });

    await flush();
    expect(started).toEqual(["s1", "s2"]);
    a.resolve();
    b.resolve();
    await flush();
  });

  it("rekeys a pending lane without running two turns at once", async () => {
    const started: string[] = [];
    const first = deferred();
    const q = createTurnQueue({ onDepth: () => {} });

    // A brand-new room: both turns arrive before the session id exists.
    q.enqueue("", async () => {
      started.push("first");
      await first.promise;
    });
    q.enqueue("", async () => {
      started.push("second");
    });
    await flush();
    expect(started).toEqual(["first"]);

    // The session event arrives mid-turn.
    q.rekey("", "s1");
    await flush();
    expect(started).toEqual(["first"]); // still one at a time

    first.resolve();
    await flush();
    expect(started).toEqual(["first", "second"]);
    expect(q.depth("s1")).toBe(0);
    expect(q.depth("")).toBe(0);
  });

  it("reports depth under the new key after a rekey", async () => {
    const seen: Array<[string, number]> = [];
    const gate = deferred();
    const q = createTurnQueue({ onDepth: (k, d) => seen.push([k, d]) });

    q.enqueue("", async () => {
      await gate.promise;
    });
    q.rekey("", "s1");
    q.enqueue("s1", async () => {});
    gate.resolve();
    await flush();

    expect(seen[0]).toEqual(["", 1]);
    expect(seen.some(([k]) => k === "s1")).toBe(true);
    expect(seen[seen.length - 1]).toEqual(["s1", 0]);
  });

  it("emits depth zero exactly once when a lane drains", async () => {
    const seen: number[] = [];
    const q = createTurnQueue({ onDepth: (_k, d) => seen.push(d) });
    q.enqueue("s1", async () => {});
    await flush();
    expect(seen).toEqual([1, 0]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/queue.test.ts`
Expected: FAIL — cannot resolve `../src/queue.js`.

- [ ] **Step 3: Write minimal implementation**

Create `agent-host/src/queue.ts`:

```ts
// Per-session FIFO. Rooms accept messages whenever — the composer never locks
// and POST /messages never returns 409 — so concurrent senders are serialized
// here instead of racing two `manager.run` calls onto one session, which forks
// the transcript.
//
// A lane is keyed by session id, with "" as the pending bucket for a room whose
// session id has not arrived yet. This mirrors the `subscribers` map in
// server.ts, which re-keys the same way when the `session` event lands.

interface Lane {
  items: Array<() => Promise<void>>;
  running: boolean;
}

export interface TurnQueue {
  /** Appends a turn to its lane and returns the lane's new depth. */
  enqueue(key: string, run: () => Promise<void>): number;
  /** Moves a lane to its real session id once that id is known. */
  rekey(from: string, to: string): void;
  depth(key: string): number;
}

export function createTurnQueue(deps: {
  onDepth: (key: string, depth: number) => void;
}): TurnQueue {
  const lanes = new Map<string, Lane>();
  // Old key -> canonical key. A drain started under "" resolves through this on
  // every step, so it keeps draining the same lane after the rekey.
  const alias = new Map<string, string>();

  const canon = (key: string): string => alias.get(key) ?? key;

  function laneFor(key: string): Lane {
    let lane = lanes.get(key);
    if (!lane) {
      lane = { items: [], running: false };
      lanes.set(key, lane);
    }
    return lane;
  }

  const depthOf = (lane: Lane): number => lane.items.length + (lane.running ? 1 : 0);

  async function drain(key: string): Promise<void> {
    const k = canon(key);
    const lane = lanes.get(k);
    if (!lane || lane.running) return;
    const next = lane.items.shift();
    if (!next) {
      // Depth 0 was already emitted by the finally below; dropping the lane
      // here keeps the map from growing one entry per room forever.
      lanes.delete(k);
      return;
    }
    lane.running = true;
    try {
      await next();
    } catch {
      // A failed turn must advance the lane, never wedge it. The turn's own
      // error already reached the room as an `error` event.
    } finally {
      lane.running = false;
      deps.onDepth(canon(k), depthOf(lane));
      void drain(k);
    }
  }

  return {
    enqueue(key, run) {
      const k = canon(key);
      const lane = laneFor(k);
      lane.items.push(run);
      const d = depthOf(lane);
      deps.onDepth(k, d);
      void drain(k);
      return d;
    },

    rekey(from, to) {
      const f = canon(from);
      const t = canon(to);
      if (f === t) return;
      const src = lanes.get(f);
      const dst = lanes.get(t);
      if (src && dst) {
        // Defensive: `to` normally has no lane yet, because a session id is new
        // the first time it arrives. If both exist, the source is older, so its
        // items go first.
        dst.items.unshift(...src.items);
        dst.running = dst.running || src.running;
        lanes.delete(f);
      } else if (src) {
        // Move the same Lane object, so an in-flight drain keeps mutating the
        // lane it is actually running on.
        lanes.set(t, src);
        lanes.delete(f);
      }
      alias.set(from, t);
      alias.set(f, t);
      void drain(t);
    },

    depth(key) {
      const lane = lanes.get(canon(key));
      return lane ? depthOf(lane) : 0;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npx vitest run test/queue.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/queue.ts agent-host/test/queue.test.ts
git commit -m "feat(agent-host): per-session turn queue with always-accept semantics"
```

---

### Task 6: Room events on the wire

Adds the three room events and broadcasts the human message to everyone watching, the moment it is accepted. The turn still runs the way it does today — Task 7 puts it through the queue.

**Files:**
- Modify: `agent-host/src/types.ts`
- Modify: `agent-host/src/server.ts`
- Test: `agent-host/test/server.test.ts`

**Interfaces:**
- Consumes: `stampAuthor` (Task 1), `readActorLogin` (Task 2)
- Produces:
  - `AgentEvent` gains `{ type: "message"; author: string; text: string; ts: string }`, `{ type: "queue"; depth: number }`, `{ type: "presence"; logins: string[] }`
  - `createServer` deps gain `now?: () => string` and `sessionSubscribers?: Map<string, Set<Response>>`

- [ ] **Step 1: Write the failing test**

Append to `agent-host/test/server.test.ts`, inside `describe("agent-host server", ...)`:

```ts
  it("broadcasts the human message to session subscribers before the turn runs", async () => {
    const written: string[] = [];
    const fakeRes = { write: (c: string) => written.push(c) } as unknown as import("express").Response;
    const sessionSubscribers = new Map<string, Set<import("express").Response>>();
    sessionSubscribers.set("s1", new Set([fakeRes]));

    const app = createServer({
      manager: fakeManager([{ type: "result", result: "ok", isError: false }]),
      sessionSubscribers,
      identity: { allowedUsers: [], insecureDev: true },
      now: () => "2026-08-04T00:00:00Z",
    });

    await request(app).post("/messages").send({ sessionId: "s1", prompt: "hi" });

    const frames = written.join("");
    expect(frames).toContain('"type":"message"');
    expect(frames).toContain('"author":"dev@local"');
    expect(frames).toContain('"text":"hi"');
    expect(frames).toContain('"ts":"2026-08-04T00:00:00Z"');
    // The message frame must precede the agent's own output.
    expect(written.findIndex((f) => f.includes('"type":"message"')))
      .toBeLessThan(written.findIndex((f) => f.includes('"type":"result"')));
  });

  it("uses the identity header as the message author", async () => {
    const written: string[] = [];
    const fakeRes = { write: (c: string) => written.push(c) } as unknown as import("express").Response;
    const sessionSubscribers = new Map<string, Set<import("express").Response>>();
    sessionSubscribers.set("s1", new Set([fakeRes]));

    const app = createServer({
      manager: fakeManager([]),
      sessionSubscribers,
      identity: { allowedUsers: ["op@example.com"], insecureDev: false },
    });

    await request(app)
      .post("/messages")
      .set("Tailscale-User-Login", "op@example.com")
      .set("Sec-Rhumb-Control", "1")
      .send({ sessionId: "s1", prompt: "hi" });

    expect(written.join("")).toContain('"author":"op@example.com"');
  });

  it("ignores an author supplied in the request body", async () => {
    const written: string[] = [];
    const fakeRes = { write: (c: string) => written.push(c) } as unknown as import("express").Response;
    const sessionSubscribers = new Map<string, Set<import("express").Response>>();
    sessionSubscribers.set("s1", new Set([fakeRes]));

    const app = createServer({
      manager: fakeManager([]),
      sessionSubscribers,
      identity: { allowedUsers: [], insecureDev: true },
    });

    await request(app)
      .post("/messages")
      .send({ sessionId: "s1", prompt: "hi", author: "attacker@evil.com" });

    const frames = written.join("");
    expect(frames).toContain('"author":"dev@local"');
    expect(frames).not.toContain("attacker@evil.com");
  });

  it("stamps the author into the prompt handed to the backend", async () => {
    const seen: string[] = [];
    const manager = {
      async run(prompt: string, sessionId: string | undefined) {
        seen.push(prompt);
        return sessionId ?? "s1";
      },
    };

    const app = createServer({
      manager,
      identity: { allowedUsers: [], insecureDev: true },
    });

    await request(app).post("/messages").send({ sessionId: "s1", prompt: "hi" });
    expect(seen).toEqual(["[from: dev@local]\nhi"]);
  });

  it("titles the session from the raw prompt, without the envelope", async () => {
    const titles: Array<[string, string]> = [];
    const app = createServer({
      manager: fakeManager([{ type: "session", sessionId: "s1" }]),
      identity: { allowedUsers: [], insecureDev: true },
      sessions: {
        upsertFromTurn: (id: string, prompt: string) => titles.push([id, prompt]),
        list: () => [],
        rename: () => false,
        archive: () => false,
        readTranscript: () => null,
      } as unknown as ReturnType<typeof createSessionService>,
    });

    await request(app).post("/messages").send({ prompt: "fix the header" });
    expect(titles).toEqual([["s1", "fix the header"]]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/server.test.ts`
Expected: FAIL — no `message` frame is written; `sessionSubscribers` and `now` are not accepted deps.

- [ ] **Step 3: Write minimal implementation**

In `agent-host/src/types.ts`, extend `AgentEvent`:

```ts
export type AgentEvent =
  | { type: "session"; sessionId: string; slashCommands?: string[] }
  | { type: "result"; result: string; isError: boolean }
  | { type: "error"; message: string }
  | { type: "raw"; message: unknown }
  // Room events. A session is shared, so the human message is broadcast to
  // every watcher rather than echoed locally by whoever typed it.
  | { type: "message"; author: string; text: string; ts: string }
  | { type: "queue"; depth: number }
  | { type: "presence"; logins: string[] };
```

In `agent-host/src/server.ts`, add imports:

```ts
import { readActorLogin } from "./identity.js";
import { stampAuthor } from "./envelope.js";
```

(`createIdentityGuard` and `requireShellHeader` are already imported from that module — extend the existing import rather than adding a second one.)

Extend the `createServer` deps type with:

```ts
  sessionSubscribers?: Map<string, Set<Response>>;
  now?: () => string;
```

Replace the `subscribers` declaration and add a clock:

```ts
  // session id -> SSE responses ("" is the pending bucket for new sessions).
  const subscribers = deps.sessionSubscribers ?? new Map<string, Set<Response>>();
  const now = deps.now ?? (() => new Date().toISOString());
```

In the `/messages` handler, after `turn` is computed and before `targetId` is declared, add:

```ts
    // Server-derived, never from the body: the room must not be able to lie
    // about who is speaking.
    const author = readActorLogin(req, deps.identity.insecureDev);
```

Immediately after `let targetId = inputId ?? "";`, add the broadcast:

```ts
    // The room sees the question the moment it is accepted. Only one client
    // typed it, but everyone in the session is watching.
    const message: AgentEvent = { type: "message", author, text: prompt, ts: now() };
    for (const r of subscribers.get(targetId) ?? []) writeSseEvent(r, message);
    if (turn) for (const r of turnSubscribers.get(turn) ?? []) writeSseEvent(r, message);
```

Finally, stamp the prompt on its way to the backend — replace:

```ts
    void deps.manager.run(prompt, inputId, onEvent);
```

with:

```ts
    // `prompt` stays raw for session titles; only the backend sees the envelope.
    void deps.manager.run(stampAuthor(author, prompt), inputId, onEvent);
```

The existing `deps.sessions?.upsertFromTurn(e.sessionId, prompt)` call already uses the raw `prompt` and must stay that way.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npm test`
Expected: PASS — the 5 new tests plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/types.ts agent-host/src/server.ts agent-host/test/server.test.ts
git commit -m "feat(agent-host): broadcast attributed room messages on /messages"
```

---

### Task 7: Serialize turns through the queue

**Files:**
- Modify: `agent-host/src/server.ts`
- Test: `agent-host/test/server.test.ts`

**Interfaces:**
- Consumes: `createTurnQueue` (Task 5), the broadcast plumbing from Task 6
- Produces: `createServer` deps gain `queue?: TurnQueue`

**Note on the watchdog:** it does not go through this queue at all. `index.ts` drives watchdog turns straight through the session manager rather than `POST /messages`, so a scheduled reconcile can never be stuck behind a human room, and its existing overlap guard in `watchdog.ts` is unchanged. Do not route it through the queue.

**Note on existing tests:** turns now start inside a microtask instead of synchronously during the request. `await request(app)...` normally flushes them. If a pre-existing test asserts on frames written during the turn and goes red on timing alone, add `await new Promise((r) => setImmediate(r));` after the request — **this is the only permitted edit to an existing test, and only for that reason.** Any other failure means the implementation is wrong.

- [ ] **Step 1: Write the failing test**

Append to `agent-host/test/server.test.ts`:

```ts
  it("runs concurrent turns on one session strictly in order", async () => {
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });

    const manager = {
      async run(prompt: string, sessionId: string | undefined) {
        started.push(prompt);
        if (started.length === 1) await firstGate;
        return sessionId ?? "s1";
      },
    };

    const app = createServer({ manager, identity: { allowedUsers: [], insecureDev: true } });

    await request(app).post("/messages").send({ sessionId: "s1", prompt: "one" });
    await request(app).post("/messages").send({ sessionId: "s1", prompt: "two" });
    await new Promise((r) => setImmediate(r));

    expect(started).toEqual(["[from: dev@local]\none"]);
    releaseFirst();
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual(["[from: dev@local]\none", "[from: dev@local]\ntwo"]);
  });

  it("still returns 202 while a turn is in flight", async () => {
    const manager = {
      async run(_p: string, sessionId: string | undefined) {
        await new Promise((r) => setTimeout(r, 20));
        return sessionId ?? "s1";
      },
    };
    const app = createServer({ manager, identity: { allowedUsers: [], insecureDev: true } });

    const a = await request(app).post("/messages").send({ sessionId: "s1", prompt: "one" });
    const b = await request(app).post("/messages").send({ sessionId: "s1", prompt: "two" });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
  });

  it("broadcasts queue depth and returns to zero when the lane drains", async () => {
    const written: string[] = [];
    const fakeRes = { write: (c: string) => written.push(c) } as unknown as import("express").Response;
    const sessionSubscribers = new Map<string, Set<import("express").Response>>();
    sessionSubscribers.set("s1", new Set([fakeRes]));

    const app = createServer({
      manager: fakeManager([{ type: "result", result: "ok", isError: false }]),
      sessionSubscribers,
      identity: { allowedUsers: [], insecureDev: true },
    });

    await request(app).post("/messages").send({ sessionId: "s1", prompt: "hi" });
    await new Promise((r) => setImmediate(r));

    const frames = written.filter((f) => f.includes('"type":"queue"'));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[frames.length - 1]).toContain('"depth":0');
  });

  it("resumes the real session for a turn queued before the session id existed", async () => {
    const resumed: Array<string | undefined> = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });

    const manager = {
      async run(
        _prompt: string,
        sessionId: string | undefined,
        onEvent: (e: AgentEvent) => void,
      ) {
        resumed.push(sessionId);
        if (resumed.length === 1) {
          onEvent({ type: "session", sessionId: "s-real" });
          await firstGate;
        }
        return "s-real";
      },
    };

    const app = createServer({ manager, identity: { allowedUsers: [], insecureDev: true } });

    // Both posted against a draft room, before any session id exists.
    await request(app).post("/messages").send({ prompt: "one" });
    await request(app).post("/messages").send({ prompt: "two" });
    await new Promise((r) => setImmediate(r));
    expect(resumed).toEqual([undefined]);

    releaseFirst();
    await new Promise((r) => setImmediate(r));
    // The queued turn must continue the session the first turn created, not
    // start a second one.
    expect(resumed).toEqual([undefined, "s-real"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/server.test.ts`
Expected: FAIL — both turns start immediately; `resumed` is `[undefined, undefined]`.

- [ ] **Step 3: Write minimal implementation**

In `agent-host/src/server.ts`, add the import:

```ts
import { createTurnQueue, type TurnQueue } from "./queue.js";
```

Add to the `createServer` deps type:

```ts
  queue?: TurnQueue;
```

After the `subscribers` and `now` declarations, add the lane plumbing:

```ts
  // Lane key -> the session id turns on that lane should resume. Populated when
  // the first turn in a draft room emits its `session` event, so a turn queued
  // before the id existed continues that session instead of starting a new one.
  const laneSession = new Map<string, string>();
  const roomKey = (lane: string): string => laneSession.get(lane) ?? lane;

  const queue =
    deps.queue ??
    createTurnQueue({
      onDepth: (lane, depth) => {
        for (const r of subscribers.get(roomKey(lane)) ?? []) {
          writeSseEvent(r, { type: "queue", depth });
        }
      },
    });
```

Then replace everything in the `/messages` handler from `let targetId = inputId ?? "";` down to and including the `void deps.manager.run(...)` line with:

```ts
    const lane = inputId ?? "";

    // The room sees the question the moment it is accepted. Only one client
    // typed it, but everyone in the session is watching.
    const message: AgentEvent = { type: "message", author, text: prompt, ts: now() };
    for (const r of subscribers.get(roomKey(lane)) ?? []) writeSseEvent(r, message);
    if (turn) for (const r of turnSubscribers.get(turn) ?? []) writeSseEvent(r, message);

    queue.enqueue(lane, async () => {
      // Resolved at run time, not enqueue time: a turn queued against a draft
      // room must resume whatever session the turn ahead of it created.
      const resume = inputId ?? laneSession.get(lane);
      let targetId = resume ?? "";

      const onEvent = (e: AgentEvent) => {
        if (e.type === "session" && e.sessionId && e.sessionId !== targetId) {
          const pending = subscribers.get(targetId);
          if (pending) {
            const dest = subsFor(subscribers, e.sessionId);
            for (const r of pending) dest.add(r);
            if (targetId === "") subscribers.delete("");
          }
          laneSession.set(lane, e.sessionId);
          queue.rekey(lane, e.sessionId);
          targetId = e.sessionId;
        }
        if (e.type === "session" && e.sessionId) {
          deps.sessions?.upsertFromTurn(e.sessionId, prompt);
        }
        for (const r of subscribers.get(targetId) ?? []) writeSseEvent(r, e);
        if (turn) {
          for (const r of turnSubscribers.get(turn) ?? []) writeSseEvent(r, e);
        }
      };

      // `prompt` stays raw for session titles; only the backend sees the envelope.
      await deps.manager.run(stampAuthor(author, prompt), resume, onEvent);
    });

    res.status(202).json({ sessionId: inputId ?? "", turnId: turn ?? "" });
```

Remove the now-duplicated `res.status(202)` line that followed the old `manager.run` call.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npm test`
Expected: PASS — the 4 new tests plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/server.ts agent-host/test/server.test.ts
git commit -m "feat(agent-host): serialize room turns through a per-session queue"
```

---

### Task 8: Presence

**Files:**
- Modify: `agent-host/src/server.ts`
- Test: `agent-host/test/server.test.ts`

**Interfaces:**
- Consumes: `readActorLogin` (Task 2), `subscribers` map
- Produces: exported `presenceLogins(subs: Set<Response> | undefined, loginOf: (r: Response) => string | undefined): string[]` — sorted and deduped

- [ ] **Step 1: Write the failing test**

Append to `agent-host/test/server.test.ts`. Add `presenceLogins` to the existing import from `../src/server.js`, and add `import http from "node:http";` at the top of the file.

```ts
describe("presenceLogins", () => {
  it("dedupes and sorts logins, ignoring responses with no recorded login", () => {
    const a = {} as import("express").Response;
    const b = {} as import("express").Response;
    const c = {} as import("express").Response;
    const d = {} as import("express").Response;
    const logins = new Map<import("express").Response, string>([
      [a, "zoe@example.com"],
      [b, "op@example.com"],
      [c, "op@example.com"],
    ]);
    expect(presenceLogins(new Set([a, b, c, d]), (r) => logins.get(r))).toEqual([
      "op@example.com",
      "zoe@example.com",
    ]);
  });

  it("returns an empty list for an absent subscriber set", () => {
    expect(presenceLogins(undefined, () => "op@example.com")).toEqual([]);
  });
});

describe("presence over SSE", () => {
  it("tells both watchers who is in the room, and again when one leaves", async () => {
    const app = createServer({
      manager: fakeManager([]),
      identity: { allowedUsers: [], insecureDev: true },
    });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as import("node:net").AddressInfo).port;

    function open(login: string) {
      const frames: string[] = [];
      return new Promise<{ frames: string[]; abort: () => void }>((resolve) => {
        const req = http.get(
          {
            port,
            path: "/sessions/s1/stream",
            headers: { "Tailscale-User-Login": login, "Sec-Rhumb-Control": "1" },
          },
          (res) => {
            res.on("data", (c: Buffer) => frames.push(c.toString()));
            resolve({ frames, abort: () => req.destroy() });
          },
        );
      });
    }

    const first = await open("op@example.com");
    const second = await open("zoe@example.com");
    await new Promise((r) => setTimeout(r, 50));

    expect(first.frames.join("")).toContain('"type":"presence"');
    expect(first.frames.join("")).toContain("zoe@example.com");
    expect(second.frames.join("")).toContain("op@example.com");

    const beforeLeave = first.frames.length;
    second.abort();
    await new Promise((r) => setTimeout(r, 50));

    const after = first.frames.slice(beforeLeave).join("");
    expect(after).toContain('"type":"presence"');
    expect(after).not.toContain("zoe@example.com");

    first.abort();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/server.test.ts`
Expected: FAIL — `presenceLogins` is not exported; no presence frames are written.

- [ ] **Step 3: Write minimal implementation**

In `agent-host/src/server.ts`, add the exported helper next to `pruneSubscriber`:

```ts
// Two connections from one person (a reconnect, or a second window) are one
// presence entry. Responses with no recorded login are subscribers that
// predate the login being tracked, and are skipped rather than shown blank.
export function presenceLogins(
  subs: Set<Response> | undefined,
  loginOf: (r: Response) => string | undefined,
): string[] {
  const out = new Set<string>();
  for (const r of subs ?? []) {
    const login = loginOf(r);
    if (login) out.add(login);
  }
  return [...out].sort();
}
```

Inside `createServer`, after the `subscribers` declaration:

```ts
  // Keyed by the response object, so presence survives the "" -> session id
  // re-key: the same responses simply move to the new bucket.
  const subscriberLogin = new WeakMap<Response, string>();

  function broadcastPresence(id: string): void {
    const subs = subscribers.get(id);
    const logins = presenceLogins(subs, (r) => subscriberLogin.get(r));
    for (const r of subs ?? []) writeSseEvent(r, { type: "presence", logins });
  }
```

Replace the `/sessions/:id/stream` handler body:

```ts
  app.get("/sessions/:id/stream", (req: Request, res: Response) => {
    res.set(SSE_HEADERS);
    res.flushHeaders?.();
    const id = req.params.id;
    subscriberLogin.set(res, readActorLogin(req, deps.identity.insecureDev));
    subsFor(subscribers, id).add(res);
    attachHeartbeat(res, req);
    broadcastPresence(id);
    req.on("close", () => {
      pruneSubscriber(subscribers, id, res);
      broadcastPresence(id);
    });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npm test`
Expected: PASS — the 3 new tests plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/server.ts agent-host/test/server.test.ts
git commit -m "feat(agent-host): broadcast room presence on subscribe and disconnect"
```

---

### Task 9: Roster endpoint

**Files:**
- Create: `agent-host/src/roster.ts`
- Modify: `agent-host/src/server.ts`
- Test: `agent-host/test/roster.test.ts`, `agent-host/test/server.test.ts`

**Interfaces:**
- Consumes: `deps.identity.allowedUsers`
- Produces: `buildRoster(logins: string[]): Array<{ login: string; handle: string }>`; `GET /roster` returning `{ roster: [...] }`

- [ ] **Step 1: Write the failing test**

Create `agent-host/test/roster.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildRoster } from "../src/roster.js";

describe("buildRoster", () => {
  it("uses the local part of a login as its handle", () => {
    expect(buildRoster(["op@example.com"])).toEqual([
      { login: "op@example.com", handle: "op" },
    ]);
  });

  it("normalizes case and whitespace, and drops blanks", () => {
    expect(buildRoster(["  Op@Example.com ", "", "   "])).toEqual([
      { login: "op@example.com", handle: "op" },
    ]);
  });

  it("dedupes repeated logins", () => {
    expect(buildRoster(["op@example.com", "op@example.com"])).toEqual([
      { login: "op@example.com", handle: "op" },
    ]);
  });

  it("falls back to the full login when two local parts collide", () => {
    expect(buildRoster(["op@a.com", "op@b.com", "zoe@a.com"])).toEqual([
      { login: "op@a.com", handle: "op@a.com" },
      { login: "op@b.com", handle: "op@b.com" },
      { login: "zoe@a.com", handle: "zoe" },
    ]);
  });

  it("passes through a login with no at-sign", () => {
    expect(buildRoster(["operator"])).toEqual([{ login: "operator", handle: "operator" }]);
  });
});
```

Append to `agent-host/test/server.test.ts`, inside `describe("agent-host server", ...)`:

```ts
  it("GET /roster returns the allowlist as logins and handles", async () => {
    const app = createServer({
      manager: fakeManager([]),
      identity: { allowedUsers: ["op@example.com", "zoe@example.com"], insecureDev: false },
    });
    const res = await request(app)
      .get("/roster")
      .set("Tailscale-User-Login", "op@example.com")
      .set("Sec-Rhumb-Control", "1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      roster: [
        { login: "op@example.com", handle: "op" },
        { login: "zoe@example.com", handle: "zoe" },
      ],
    });
  });

  it("GET /roster is behind the identity guard", async () => {
    const app = createServer({
      manager: fakeManager([]),
      identity: { allowedUsers: ["op@example.com"], insecureDev: false },
    });
    const res = await request(app).get("/roster");
    expect(res.status).toBe(403);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/roster.test.ts test/server.test.ts`
Expected: FAIL — cannot resolve `../src/roster.js`; `/roster` 404s.

- [ ] **Step 3: Write minimal implementation**

Create `agent-host/src/roster.ts`:

```ts
// The @-mention roster is derived from RHUMB_ALLOWED_USERS — the same list the
// identity guard authenticates against, so the room can only mention people who
// can actually get in. There is no source of display names, so the handle is the
// local part of the login, and it degrades to the full login when that would be
// ambiguous.
export interface RosterEntry {
  login: string;
  handle: string;
}

const localPart = (login: string): string =>
  login.includes("@") ? login.slice(0, login.indexOf("@")) : login;

export function buildRoster(logins: string[]): RosterEntry[] {
  const cleaned = [...new Set(logins.map((l) => l.trim().toLowerCase()).filter(Boolean))];
  const counts = new Map<string, number>();
  for (const login of cleaned) {
    const local = localPart(login);
    counts.set(local, (counts.get(local) ?? 0) + 1);
  }
  return cleaned.map((login) => {
    const local = localPart(login);
    return { login, handle: (counts.get(local) ?? 0) > 1 ? login : local };
  });
}
```

In `agent-host/src/server.ts`, add the import:

```ts
import { buildRoster } from "./roster.js";
```

and add the route immediately after the `/sessions/:id/stream` handler:

```ts
  app.get("/roster", (_req: Request, res: Response) => {
    res.json({ roster: buildRoster(deps.identity.allowedUsers) });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npm test`
Expected: PASS — 7 new tests plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/roster.ts agent-host/src/server.ts agent-host/test/roster.test.ts agent-host/test/server.test.ts
git commit -m "feat(agent-host): roster endpoint for @-mention autocomplete"
```

---

### Task 10: Infra approval actors

Records who resolved a gated infrastructure action, and stops a second approver from getting a bare 404 when someone beat them to it.

**Files:**
- Modify: `agent-host/src/infra/types.ts`
- Modify: `agent-host/src/infra/pending.ts`
- Modify: `agent-host/src/infra/router.ts`
- Modify: `agent-host/src/infra/server.ts`
- Modify: `agent-host/src/index.ts`
- Test: `agent-host/test/infra-pending.test.ts`, `agent-host/test/infra-router.test.ts`

**Interfaces:**
- Consumes: `readActorLogin` (Task 2)
- Produces:
  - `PendingAction.resolvedBy?: string`
  - `InfraAuditEntry.actor?: string`
  - `PendingActions.resolve(pendingId: string, decision: "approve" | "deny", actor?: string): boolean`
  - `createInfraRouter` deps gain `actorOf?: (req: Request) => string`
  - `auditResolution` signature becomes `(a: PendingAction, decision: "approved" | "denied", actor: string) => void`

- [ ] **Step 1: Write the failing test**

Append to `agent-host/test/infra-pending.test.ts`:

```ts
describe("resolution actor", () => {
  it("records who resolved the action", () => {
    const pending = new PendingActions({ now: () => "2026-08-04T00:00:00Z", id: () => "p1" });
    const { action } = pending.enqueue("create_vm", {});
    expect(pending.resolve("p1", "approve", "op@example.com")).toBe(true);
    expect(pending.get("p1")?.resolvedBy).toBe("op@example.com");
    expect(action.status).toBe("approved");
  });

  it("leaves resolvedBy unset when no actor is supplied", () => {
    const pending = new PendingActions({ now: () => "2026-08-04T00:00:00Z", id: () => "p1" });
    pending.enqueue("create_vm", {});
    pending.resolve("p1", "approve");
    expect(pending.get("p1")?.resolvedBy).toBeUndefined();
  });

  it("keeps the first decision when two people resolve the same action", () => {
    const pending = new PendingActions({ now: () => "2026-08-04T00:00:00Z", id: () => "p1" });
    pending.enqueue("create_vm", {});
    expect(pending.resolve("p1", "approve", "first@example.com")).toBe(true);
    expect(pending.resolve("p1", "deny", "second@example.com")).toBe(false);
    expect(pending.get("p1")?.status).toBe("approved");
    expect(pending.get("p1")?.resolvedBy).toBe("first@example.com");
  });
});
```

Append to `agent-host/test/infra-router.test.ts`:

```ts
describe("resolve attribution", () => {
  it("records the acting login on approval", async () => {
    const pending = new PendingActions({ now: () => "2026-08-04T00:00:00Z", id: () => "p1" });
    pending.enqueue("create_vm", {});
    const app = express();
    app.use(express.json());
    app.use(
      "/infra",
      createInfraRouter({ pending, actorOf: (req) => req.get("tailscale-user-login") ?? "" }),
    );

    const res = await request(app)
      .post("/infra/pending/p1/resolve")
      .set("Tailscale-User-Login", "op@example.com")
      .send({ decision: "approve" });

    expect(res.status).toBe(200);
    expect(pending.get("p1")?.resolvedBy).toBe("op@example.com");
  });

  it("tells a second approver who won, instead of a bare 404", async () => {
    const pending = new PendingActions({ now: () => "2026-08-04T00:00:00Z", id: () => "p1" });
    pending.enqueue("create_vm", {});
    const app = express();
    app.use(express.json());
    app.use(
      "/infra",
      createInfraRouter({ pending, actorOf: (req) => req.get("tailscale-user-login") ?? "" }),
    );

    await request(app)
      .post("/infra/pending/p1/resolve")
      .set("Tailscale-User-Login", "first@example.com")
      .send({ decision: "approve" });

    const res = await request(app)
      .post("/infra/pending/p1/resolve")
      .set("Tailscale-User-Login", "second@example.com")
      .send({ decision: "deny" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "already resolved",
      by: "first@example.com",
      decision: "approved",
    });
  });

  it("still 404s an unknown pending id", async () => {
    const pending = new PendingActions({ now: () => "2026-08-04T00:00:00Z", id: () => "p1" });
    const app = express();
    app.use(express.json());
    app.use("/infra", createInfraRouter({ pending }));

    const res = await request(app).post("/infra/pending/nope/resolve").send({ decision: "approve" });
    expect(res.status).toBe(404);
  });
});
```

`agent-host/test/infra-router.test.ts` needs these imports; add any the file does not already have:

```ts
import express from "express";
import request from "supertest";
import { PendingActions } from "../src/infra/pending.js";
import { createInfraRouter } from "../src/infra/router.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/infra-pending.test.ts test/infra-router.test.ts`
Expected: FAIL — `resolve` takes two arguments; the second approver gets 404.

- [ ] **Step 3: Write minimal implementation**

In `agent-host/src/infra/types.ts`, add to `PendingAction`:

```ts
  // Who approved or denied this. Pairs with `proposedBy`: in a shared room,
  // "the operator decided" stops being enough on its own.
  resolvedBy?: string;
```

and to `InfraAuditEntry`:

```ts
  actor?: string;
```

In `agent-host/src/infra/pending.ts`, change `resolve`:

```ts
  resolve(pendingId: string, decision: "approve" | "deny", actor?: string): boolean {
    const entry = this.entries.get(pendingId);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    entry.action.status = decision === "approve" ? "approved" : "denied";
    entry.action.resolvedAt = this.now();
    if (actor) entry.action.resolvedBy = actor;
    entry.resolve(decision);
    this.save();
    for (const fn of this.listeners) fn("resolved", entry.action);
    return true;
  }
```

In `agent-host/src/infra/router.ts`, add `actorOf` to the deps type:

```ts
  // Derives the acting login from the request. Omitted in tests that do not
  // care about attribution; index.ts supplies the identity-header reader.
  actorOf?: (req: Request) => string;
```

change `auditResolution`'s type to `(a: PendingAction, decision: "approved" | "denied", actor: string) => void`, and replace the resolve handler:

```ts
  router.post("/pending/:id/resolve", (req: Request, res: Response) => {
    const { decision } = req.body ?? {};
    if (decision !== "approve" && decision !== "deny") return void res.status(400).json({ error: "bad decision" });
    const entry = deps.pending.get(req.params.id);
    const actor = deps.actorOf?.(req) ?? "";
    const ok = deps.pending.resolve(req.params.id, decision, actor);
    if (!ok) {
      if (!entry) return void res.sendStatus(404);
      // Everyone in the room sees the same dialog, so two people can hit
      // approve at once. First decision wins; the loser is told who won
      // rather than being handed a confusing 404.
      const settled = deps.pending.get(req.params.id);
      return void res.status(409).json({
        error: "already resolved",
        by: settled?.resolvedBy ?? "",
        decision: settled?.status ?? "",
      });
    }
    if (entry?.mode === "parked") {
      deps.auditResolution?.(entry, decision === "approve" ? "approved" : "denied", actor);
      if (decision === "approve") {
        void deps.executeParked?.(deps.pending.get(req.params.id) as PendingAction);
      }
    }
    res.json({ ok: true });
  });
```

In `agent-host/src/infra/server.ts`, the blocking gate audits after awaiting the decision, and by then `resolvedBy` is set — so read it back. Replace the audit call on line 50:

```ts
    appendInfraAudit(deps.auditPath, {
      ts: deps.now(), tool: toolName, input,
      decision: d === "approve" ? "approved" : "denied",
      actor: deps.pending.get(action.pendingId)?.resolvedBy,
    });
```

In `agent-host/src/index.ts`, pass the reader into the router. Find the `createInfraRouter({ ... })` call (near the `pending: infraPending` reference around line 269) and add:

```ts
      actorOf: (req) => readActorLogin(req, deps.config.insecureDev),
```

Add `readActorLogin` to the existing import from `./identity.js`, adding the import if the file has none. Where `index.ts` supplies `auditResolution`, extend its callback to accept and record the third `actor` argument:

```ts
      auditResolution: (a, decision, actor) =>
        appendInfraAudit(infra.auditPath, {
          ts: now(), tool: a.tool, input: a.input, decision, actor: actor || undefined,
        }),
```

If the existing `auditResolution` body differs, keep its existing fields and only add `actor: actor || undefined`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npm test`
Expected: PASS — 6 new tests plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/infra agent-host/src/index.ts agent-host/test/infra-pending.test.ts agent-host/test/infra-router.test.ts
git commit -m "feat(agent-host): attribute infra approvals to the acting login"
```

---

### Task 11: Dashboard-host audit actor

Completes the F23 distinction: `auth` says *what* authorized a write, `actor` says *who*. Set only on the approval path — a trust-path execution has no human in the loop, and leaving it unset is the honest encoding.

**Files:**
- Modify: `dashboard-host/src/identity.ts`
- Modify: `dashboard-host/src/data/types.ts`
- Modify: `dashboard-host/src/data/writes.ts`
- Modify: `dashboard-host/src/data/router.ts`
- Modify: `dashboard-host/src/index.ts`
- Test: `dashboard-host/test/identity.test.ts`, `dashboard-host/test/writes.test.ts`, `dashboard-host/test/data-router.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — `dashboard-host` is a separate package with no shared module, and the codebase already hand-mirrors across the two hosts
- Produces:
  - `dashboard-host` `readActorLogin(req, insecureDev): string` and `DEV_ACTOR` (same contract as Task 2)
  - `AuditEntry.actor?: string`
  - `executeWrite(deps, source, op, surfaceId, auth, actor?)`
  - `PendingQueue.resolve(pendingId, decision, actor?)`
  - `DataRouterDeps.actorOf?: (req: Request) => string`

- [ ] **Step 1: Write the failing test**

Append to `dashboard-host/test/identity.test.ts` the same four `readActorLogin` tests as Task 2 (repeated here in full, because these are separate packages and the engineer may be reading tasks out of order):

```ts
describe("readActorLogin", () => {
  const reqWith = (login?: string) => ({
    get: (name: string) =>
      name.toLowerCase() === "tailscale-user-login" ? login : undefined,
  });

  it("returns the header login, lowercased and trimmed", () => {
    expect(readActorLogin(reqWith("  Op@Example.com "), false)).toBe("op@example.com");
  });

  it("falls back to the dev sentinel when there is no header in dev mode", () => {
    expect(readActorLogin(reqWith(undefined), true)).toBe(DEV_ACTOR);
    expect(DEV_ACTOR).toBe("dev@local");
  });

  it("returns empty when there is no header in identity mode", () => {
    expect(readActorLogin(reqWith(undefined), false)).toBe("");
  });

  it("prefers a real header over the dev sentinel", () => {
    expect(readActorLogin(reqWith("op@example.com"), true)).toBe("op@example.com");
  });
});
```

Add `readActorLogin, DEV_ACTOR` to that file's existing import from `../src/identity.js`.

Append to `dashboard-host/test/writes.test.ts`:

```ts
describe("audit actor", () => {
  it("records the approver on an approved write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rhumb-actor-"));
    const auditPath = join(dir, "audit.jsonl");
    const executor = { run: async () => ({ rows: [], rowCount: 1 }) };

    await executeWrite(
      { getExecutor: () => executor, auditPath, now: () => "2026-08-04T00:00:00Z", id: () => "w1" },
      "printers",
      { kind: "insert", table: "spools", values: { name: "x" } },
      "filament-spools",
      "approval",
      "op@example.com",
    );

    const entry = JSON.parse(readFileSync(auditPath, "utf8").trim());
    expect(entry.auth).toBe("approval");
    expect(entry.actor).toBe("op@example.com");
  });

  it("leaves actor unset on a trust-path write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rhumb-actor-"));
    const auditPath = join(dir, "audit.jsonl");
    const executor = { run: async () => ({ rows: [], rowCount: 1 }) };

    await executeWrite(
      { getExecutor: () => executor, auditPath, now: () => "2026-08-04T00:00:00Z", id: () => "w1" },
      "printers",
      { kind: "insert", table: "spools", values: { name: "x" } },
      "filament-spools",
      "trust",
    );

    const entry = JSON.parse(readFileSync(auditPath, "utf8").trim());
    expect(entry.auth).toBe("trust");
    expect(entry.actor).toBeUndefined();
  });
});
```

Add `mkdtempSync`, `readFileSync`, `tmpdir`, and `join` imports if the file lacks them.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard-host && npx vitest run test/identity.test.ts test/writes.test.ts`
Expected: FAIL — `readActorLogin` is not exported; `entry.actor` is `undefined` on the approval write.

- [ ] **Step 3: Write minimal implementation**

Append to `dashboard-host/src/identity.ts` (same code as Task 2 — the two hosts are separate packages and already hand-mirror shared shapes):

```ts
// In dev mode there is no `tailscale serve` and therefore no identity header,
// but an approval still needs an actor. One fixed sentinel is clearer than a
// per-request guess. Mirrors agent-host/src/identity.ts.
export const DEV_ACTOR = "dev@local";

export function readActorLogin(
  req: { get(name: string): string | undefined },
  insecureDev: boolean,
): string {
  const login = req.get("tailscale-user-login")?.trim().toLowerCase() ?? "";
  if (login) return login;
  return insecureDev ? DEV_ACTOR : "";
}
```

In `dashboard-host/src/data/types.ts`, add to `AuditEntry`:

```ts
  // Who approved this write. Set only when auth === "approval": a trust-path
  // execution has no human in the loop, so an actor there would be a lie.
  actor?: string;
```

In `dashboard-host/src/data/writes.ts`, add the parameter and thread it into the success audit:

```ts
export async function executeWrite(
  deps: WriteDeps,
  source: string,
  op: DataOp,
  surfaceId: string | null,
  auth: "approval" | "trust",
  actor?: string,
): Promise<{ rowCount: number }> {
  try {
    const result = await deps.getExecutor(source).run(buildSql(op));
    appendAudit(deps.auditPath, {
      ts: deps.now(), source, surfaceId, op, decision: "executed", rowCount: result.rowCount, auth,
      ...(auth === "approval" && actor ? { actor } : {}),
    });
    return { rowCount: result.rowCount };
  } catch (err) {
```

Leave the catch block unchanged.

In the same file, thread the actor through `PendingQueue.resolve`:

```ts
  async resolve(pendingId: string, decision: "approve" | "deny", actor?: string): Promise<void> {
    const w = this.pending.get(pendingId);
    if (!w || this.status.get(pendingId)?.status !== "pending") return;
    if (decision === "approve") {
      const result = await executeWrite(this.deps, w.source, w.op, w.surfaceId, "approval", actor);
      this.status.set(pendingId, { status: "executed", result });
    } else {
      appendAudit(this.deps.auditPath, {
        ts: this.deps.now(), source: w.source, surfaceId: w.surfaceId, op: w.op, decision: "denied",
        ...(actor ? { actor } : {}),
      });
      this.status.set(pendingId, { status: "denied" });
    }
    for (const fn of this.listeners) fn("resolved", w);
  }
```

In `dashboard-host/src/data/router.ts`, add to `DataRouterDeps`:

```ts
  actorOf?: (req: Request) => string;
```

and in the `/pending/:id/resolve` handler, replace the resolve call:

```ts
      await deps.queue.resolve(req.params.id, decision, deps.actorOf?.(req) ?? "");
```

In `dashboard-host/src/index.ts`, find the `createDataRouter({ ... })` call and add:

```ts
    actorOf: (req) => readActorLogin(req, config.insecureDev),
```

importing `readActorLogin` from `./identity.js`. If the local config variable is not named `config`, use whatever that file already calls it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard-host && npm test`
Expected: PASS — 6 new tests plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add dashboard-host/src dashboard-host/test
git commit -m "feat(dashboard-host): record which operator approved a gated write"
```

---

### Task 12: Mirror room events into the client types

`agent-host/src/types.ts` and `client/src/lib/types.ts` are hand-mirrored by contract — both file headers say to change them together, so plan 1 does not end with them out of sync. `reduceAgent` switches on `AgentEvent` with no `default` branch, so adding variants without cases makes the return type `AgentState | undefined` and breaks the build. This task adds pass-through cases only; plan 2 replaces them with real rendering.

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/agentEvents.ts`
- Test: `client/test/agentEvents.test.ts`

**Interfaces:**
- Consumes: the `AgentEvent` shape from Task 6
- Produces: client-side `AgentEvent` parity; `TranscriptMessage.author?: string`

- [ ] **Step 1: Write the failing test**

Append to `client/test/agentEvents.test.ts`:

```ts
describe("room events", () => {
  it("leaves state untouched for message, queue, and presence in plan 1", () => {
    const state = { ...initialAgentState, messages: [{ kind: "text" as const, text: "hi" }] };
    expect(
      reduceAgent(state, {
        type: "message",
        author: "op@example.com",
        text: "hi",
        ts: "2026-08-04T00:00:00Z",
      }),
    ).toBe(state);
    expect(reduceAgent(state, { type: "queue", depth: 2 })).toBe(state);
    expect(reduceAgent(state, { type: "presence", logins: ["op@example.com"] })).toBe(state);
  });

});
```

`TranscriptMessage.author` needs no test of its own: it is a compile-time addition, and a runtime assertion on a literal object would assert nothing. The reducer test above already fails to compile if either the union or the field is missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/agentEvents.test.ts`
Expected: FAIL — `message`, `queue`, and `presence` are not assignable to `AgentEvent`; `author` is not a property of `TranscriptMessage`.

- [ ] **Step 3: Write minimal implementation**

In `client/src/lib/types.ts`, extend `AgentEvent` to match `agent-host/src/types.ts` exactly:

```ts
export type AgentEvent =
  | { type: "session"; sessionId: string; slashCommands?: string[] }
  | { type: "result"; result: string; isError: boolean }
  | { type: "error"; message: string }
  | { type: "raw"; message: unknown }
  // Room events. A session is shared, so the human message is broadcast to
  // every watcher rather than echoed locally by whoever typed it.
  | { type: "message"; author: string; text: string; ts: string }
  | { type: "queue"; depth: number }
  | { type: "presence"; logins: string[] };
```

In `client/src/lib/agentEvents.ts`, add `author` to `TranscriptMessage`:

```ts
  // Sender login for user messages in a shared room. Rendering lands in plan 2.
  author?: string;
```

and add pass-through cases at the end of the `reduceAgent` switch, after `case "raw"`:

```ts
    // Plan 1 mirrors the wire contract so the packages stay in sync and the
    // switch stays exhaustive. Rendering these is plan 2.
    case "message":
    case "queue":
    case "presence":
      return state;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test`
Expected: PASS — 1 new test plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/agentEvents.ts client/test/agentEvents.test.ts
git commit -m "feat(client): mirror room events into the client wire types"
```

---

### Task 13: Full-suite verification

**Files:** none — verification only.

- [ ] **Step 1: Build and test agent-host**

Run: `cd agent-host && npm run build && npm test`
Expected: build succeeds with no TypeScript errors; all tests pass.

- [ ] **Step 2: Build and test dashboard-host**

Run: `cd dashboard-host && npm run build && npm test`
Expected: build succeeds; all tests pass.

- [ ] **Step 3: Test the client**

Run: `cd client && npm test`
Expected: all tests pass.

- [ ] **Step 4: Confirm the mirrored contract actually matches**

Run: `diff <(sed -n '/export type AgentEvent/,/presence/p' agent-host/src/types.ts) <(sed -n '/export type AgentEvent/,/presence/p' client/src/lib/types.ts)`
Expected: no output. If the union bodies differ, fix the client to match the host.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "test: verify multi-user room server slice builds and passes green"
```

---

## Deferred to plan 2

- Rendering authors, presence, and queue depth in the client
- Stopping the local echo in `Composer` so the sender renders from the broadcast
- @-mention autocomplete against `GET /roster`
- Surfacing the 409 "already resolved by …" response in `ConfirmationDialog`

## Deferred beyond both plans (from the spec)

- Mention notifications
- Display names
- Fleet-backed rooms
