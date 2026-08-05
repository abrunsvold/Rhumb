import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer, pruneSubscriber, stripAgentPrefix, presenceLogins } from "../src/server.js";
import type { AgentEvent } from "../src/types.js";
import { mkdtempSync, readFileSync as readFileSyncFs, existsSync as existsSyncFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionService } from "../src/sessions.js";
import http from "node:http";

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

describe("stripAgentPrefix", () => {
  it("normalizes the serve mount prefix including bare and query-only forms", () => {
    expect(stripAgentPrefix("/agent")).toBe("/");
    expect(stripAgentPrefix("/agent/messages")).toBe("/messages");
    expect(stripAgentPrefix("/agent?x=1")).toBe("/?x=1");
    expect(stripAgentPrefix("/agent/healthz?x=1")).toBe("/healthz?x=1");
    expect(stripAgentPrefix("/agentx")).toBe("/agentx");
    expect(stripAgentPrefix("/messages")).toBe("/messages");
  });
});

describe("agent-host server", () => {
  it("GET /healthz returns ok", async () => {
    const app = createServer({ manager: fakeManager([]), identity: { allowedUsers: [], insecureDev: true } });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("POST /messages without a prompt is a 400", async () => {
    const app = createServer({ manager: fakeManager([]), identity: { allowedUsers: [], insecureDev: true } });
    const res = await request(app).post("/messages").send({});
    expect(res.status).toBe(400);
  });

  it("POST /messages with a prompt returns 202 and an echoed sessionId", async () => {
    const app = createServer({ manager: fakeManager([{ type: "result", result: "ok", isError: false }]), identity: { allowedUsers: [], insecureDev: true } });
    const res = await request(app)
      .post("/messages")
      .send({ sessionId: "sess-9", prompt: "hi" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sessionId: "sess-9", turnId: "" });
  });

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
      identity: { allowedUsers: [], insecureDev: true },
    });

    const res = await request(app).post("/messages").send({ turnId: "t1", prompt: "hi" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sessionId: "", turnId: "t1" });

    const frames = written.join("");
    expect(frames).toContain('"type":"session"');
    expect(frames).toContain('"type":"result"');
  });

  it("pruneSubscriber keeps the entry while other subscribers remain, deletes it when empty", () => {
    const a = {} as import("express").Response;
    const b = {} as import("express").Response;
    const map = new Map<string, Set<import("express").Response>>();
    map.set("t9", new Set([a, b]));

    pruneSubscriber(map, "t9", a);
    expect(map.get("t9")?.has(b)).toBe(true); // still present

    pruneSubscriber(map, "t9", b);
    expect(map.has("t9")).toBe(false); // key reaped when empty
  });

  it("pruneSubscriber is a no-op for an unknown id", () => {
    const map = new Map<string, Set<import("express").Response>>();
    expect(() => pruneSubscriber(map, "missing", {} as import("express").Response)).not.toThrow();
  });

  describe("control-token auth", () => {
    const token = "s3cr3t-operator-token";

    it("rejects POST /messages without the token when a control token is configured", async () => {
      const app = createServer({ manager: fakeManager([]), identity: { allowedUsers: [], insecureDev: true, controlToken: token } });
      const res = await request(app).post("/messages").send({ prompt: "hi" });
      expect(res.status).toBe(401);
    });

    it("rejects POST /messages with a wrong token", async () => {
      const app = createServer({ manager: fakeManager([]), identity: { allowedUsers: [], insecureDev: true, controlToken: token } });
      const res = await request(app).post("/messages").set("Authorization", "Bearer wrong").send({ prompt: "hi" });
      expect(res.status).toBe(401);
    });

    it("accepts POST /messages with the correct bearer token", async () => {
      const app = createServer({ manager: fakeManager([{ type: "result", result: "ok", isError: false }]), identity: { allowedUsers: [], insecureDev: true, controlToken: token } });
      const res = await request(app).post("/messages").set("Authorization", `Bearer ${token}`).send({ prompt: "hi" });
      expect(res.status).toBe(202);
    });

    it("leaves /healthz open even when a token is configured", async () => {
      const app = createServer({ manager: fakeManager([]), identity: { allowedUsers: [], insecureDev: true, controlToken: token } });
      const res = await request(app).get("/healthz");
      expect(res.status).toBe(200);
    });
  });

  describe("POST /files", () => {
    function appWithWorkspace(identity?: { allowedUsers: string[]; insecureDev: boolean; controlToken?: string }) {
      const ws = mkdtempSync(join(tmpdir(), "rhumb-ws-"));
      const app = createServer({ manager: fakeManager([]), workspace: ws, identity: identity ?? { allowedUsers: [], insecureDev: true } });
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
      expect(readFileSyncFs(join(ws, "uploads", "r.txt"), "utf8")).toBe("one");
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
      const app = createServer({ manager: fakeManager([]), identity: { allowedUsers: [], insecureDev: true } });
      const res = await request(app).post("/files").send({ name: "a.txt", contentBase64: b64("x") });
      expect(res.status).toBe(404);
    });

    it("requires the control token when configured", async () => {
      const { app } = appWithWorkspace({ allowedUsers: [], insecureDev: true, controlToken: "sekrit" });
      const denied = await request(app).post("/files").send({ name: "a.txt", contentBase64: b64("x") });
      expect(denied.status).toBe(401);
      const ok = await request(app)
        .post("/files")
        .set("Authorization", "Bearer sekrit")
        .send({ name: "a.txt", contentBase64: b64("x") });
      expect(ok.status).toBe(200);
    });

    it("rejects an unauthenticated request with an invalid JSON body with 401, not 400", async () => {
      const { app } = appWithWorkspace({ allowedUsers: [], insecureDev: true, controlToken: "sekrit" });
      const res = await request(app)
        .post("/files")
        .set("Content-Type", "application/json")
        .send("{not json");
      expect(res.status).toBe(401);
    });
  });

  function appWithSessions(
    script: AgentEvent[] = [{ type: "session", sessionId: "s-1" }],
    identity: { allowedUsers: string[]; insecureDev: boolean; controlToken?: string } = {
      allowedUsers: [],
      insecureDev: true,
    },
  ) {
    const dir = mkdtempSync(join(tmpdir(), "rhumb-sessapp-"));
    const sessions = createSessionService({
      indexPath: join(dir, "sessions.json"),
      projectsDir: join(dir, "projects"),
      workspace: join(dir, "ws"),
      now: () => "2026-07-02T00:00:00Z",
    });
    const app = createServer({ manager: fakeManager(script), sessions, identity });
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

    it("session routes require the control token in dev mode when configured", async () => {
      const { app } = appWithSessions([], { allowedUsers: [], insecureDev: true, controlToken: "sekrit" });
      expect((await request(app).get("/sessions")).status).toBe(401);
      expect((await request(app).get("/sessions").set("Authorization", "Bearer sekrit")).status).toBe(200);
    });

    it("session routes require identity + shell header in identity mode", async () => {
      const { app } = appWithSessions([], { allowedUsers: ["op@example.com"], insecureDev: false });
      expect((await request(app).get("/sessions")).status).toBe(403);
      expect(
        (await request(app).get("/sessions").set("Tailscale-User-Login", "op@example.com")).status,
      ).toBe(403);
      expect(
        (
          await request(app)
            .get("/sessions")
            .set("Tailscale-User-Login", "op@example.com")
            .set("Sec-Rhumb-Control", "1")
        ).status,
      ).toBe(200);
    });

    it("routes are absent when no session service is configured", async () => {
      const app = createServer({ manager: fakeManager([]), identity: { allowedUsers: [], insecureDev: true } });
      expect((await request(app).get("/sessions")).status).toBe(404);
    });
  });

  describe("identity mode", () => {
    const identity = { allowedUsers: ["op@example.com"], insecureDev: false };
    const shellHeaders = { "Tailscale-User-Login": "op@example.com", "Sec-Rhumb-Control": "1" };

    it("rejects POST /messages without an identity header", async () => {
      const app = createServer({ manager: fakeManager([]), identity });
      expect((await request(app).post("/messages").send({ prompt: "hi" })).status).toBe(403);
    });

    it("rejects an allowlisted identity without the shell header", async () => {
      const app = createServer({ manager: fakeManager([]), identity });
      const res = await request(app).post("/messages").set("Tailscale-User-Login", "op@example.com").send({ prompt: "hi" });
      expect(res.status).toBe(403);
    });

    it("accepts an allowlisted identity with the shell header", async () => {
      const app = createServer({ manager: fakeManager([{ type: "result", result: "ok", isError: false }]), identity });
      const res = await request(app).post("/messages").set(shellHeaders).send({ prompt: "hi" });
      expect(res.status).toBe(202);
    });

    it("leaves /healthz open with no headers", async () => {
      const app = createServer({ manager: fakeManager([]), identity });
      expect((await request(app).get("/healthz")).status).toBe(200);
    });

    it("normalizes the /agent serve mount prefix", async () => {
      const app = createServer({ manager: fakeManager([{ type: "result", result: "ok", isError: false }]), identity });
      expect((await request(app).get("/agent/healthz")).status).toBe(200);
      expect((await request(app).post("/agent/messages").set(shellHeaders).send({ prompt: "hi" })).status).toBe(202);
    });
  });

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

  it("starts a fresh session for a new room after an earlier room finished", async () => {
    const resumed: Array<string | undefined> = [];
    const manager = {
      async run(
        _prompt: string,
        sessionId: string | undefined,
        onEvent: (e: AgentEvent) => void,
      ) {
        resumed.push(sessionId);
        onEvent({ type: "session", sessionId: "s1" });
        return "s1";
      },
    };

    const app = createServer({ manager, identity: { allowedUsers: [], insecureDev: true } });

    await request(app).post("/messages").send({ prompt: "first chat" });
    await new Promise((r) => setImmediate(r));
    await request(app).post("/messages").send({ prompt: "second chat" });
    await new Promise((r) => setImmediate(r));

    // Both are brand-new rooms. The second must not inherit the first room's
    // session through the shared "" draft bucket.
    expect(resumed).toEqual([undefined, undefined]);
  });

  it("adopts the session id returned by a backend that emits no session event", async () => {
    const resumed: Array<string | undefined> = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });

    // Emits nothing: the returned id is the only source of session identity.
    const manager = {
      async run(_prompt: string, sessionId: string | undefined) {
        resumed.push(sessionId);
        if (resumed.length === 1) await firstGate;
        return "s-quiet";
      },
    };

    const app = createServer({ manager, identity: { allowedUsers: [], insecureDev: true } });

    await request(app).post("/messages").send({ prompt: "one" });
    await request(app).post("/messages").send({ prompt: "two" });
    await new Promise((r) => setImmediate(r));
    expect(resumed).toEqual([undefined]);

    releaseFirst();
    await new Promise((r) => setImmediate(r));
    expect(resumed).toEqual([undefined, "s-quiet"]);
  });

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
});

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
