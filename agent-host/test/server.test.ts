import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer, pruneSubscriber } from "../src/server.js";
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
});
