import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer, pruneSubscriber } from "../src/server.js";
import type { AgentEvent } from "../src/types.js";
import { mkdtempSync, readFileSync as readFileSyncFs, existsSync as existsSyncFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionService } from "../src/sessions.js";

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
      const app = createServer({ manager: fakeManager([]), controlToken: token });
      const res = await request(app).post("/messages").send({ prompt: "hi" });
      expect(res.status).toBe(401);
    });

    it("rejects POST /messages with a wrong token", async () => {
      const app = createServer({ manager: fakeManager([]), controlToken: token });
      const res = await request(app).post("/messages").set("Authorization", "Bearer wrong").send({ prompt: "hi" });
      expect(res.status).toBe(401);
    });

    it("accepts POST /messages with the correct bearer token", async () => {
      const app = createServer({ manager: fakeManager([{ type: "result", result: "ok", isError: false }]), controlToken: token });
      const res = await request(app).post("/messages").set("Authorization", `Bearer ${token}`).send({ prompt: "hi" });
      expect(res.status).toBe(202);
    });

    it("leaves /healthz open even when a token is configured", async () => {
      const app = createServer({ manager: fakeManager([]), controlToken: token });
      const res = await request(app).get("/healthz");
      expect(res.status).toBe(200);
    });
  });

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

    it("rejects an unauthenticated request with an invalid JSON body with 401, not 400", async () => {
      const { app } = appWithWorkspace({ controlToken: "sekrit" });
      const res = await request(app)
        .post("/files")
        .set("Content-Type", "application/json")
        .send("{not json");
      expect(res.status).toBe(401);
    });
  });

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
});
