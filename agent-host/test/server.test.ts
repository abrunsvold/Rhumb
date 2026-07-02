import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer, pruneSubscriber } from "../src/server.js";
import type { AgentEvent } from "../src/types.js";
import { mkdtempSync, readFileSync as readFileSyncFs, existsSync as existsSyncFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
