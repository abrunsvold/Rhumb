import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataRouter } from "../src/data/router.js";
import { PendingQueue } from "../src/data/writes.js";
import type { QueryExecutor, DataSource } from "../src/data/types.js";

let dir: string;
let calls: { text: string; params: unknown[] }[];
const executor: QueryExecutor = {
  async run(sql) { calls.push(sql); return { rows: [{ id: 1 }], rowCount: 1 }; },
};
const sources: DataSource[] = [
  { id: "ops", type: "postgres", mode: "read-write", connectionString: "x" },
  { id: "rep", type: "postgres", mode: "read", connectionString: "x" },
];

function app() {
  let n = 0;
  const now = () => "T";
  const getExecutor = () => executor;
  const queue = new PendingQueue({ getExecutor, auditPath: join(dir, "audit.jsonl"), now, id: () => `p${++n}` });
  const router = createDataRouter({
    getSources: () => sources, getExecutor, queue, trustPath: join(dir, "trust.json"), auditPath: join(dir, "audit.jsonl"), now,
    resolveToken: () => "d1",
  });
  const a = express();
  a.use(express.json());
  a.use("/data", router);
  return a;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-dr-")); calls = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("data router", () => {
  it("query runs a select and returns rows", async () => {
    const res = await request(app()).post("/data/ops/query").set("X-Rhumb-Surface-Token", "x").send({ op: { kind: "select", table: "t", where: { id: 1 } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [{ id: 1 }] });
    expect(calls[0].text).toContain("SELECT");
  });

  it("query rejects a non-select op", async () => {
    const res = await request(app()).post("/data/ops/query").set("X-Rhumb-Surface-Token", "x").send({ op: { kind: "delete", table: "t", where: { id: 1 } } });
    expect(res.status).toBe(400);
  });

  it("query 404s an unknown source", async () => {
    const res = await request(app()).post("/data/missing/query").set("X-Rhumb-Surface-Token", "x").send({ op: { kind: "select", table: "t" } });
    expect(res.status).toBe(404);
  });

  it("write to a read-only source is 403", async () => {
    const res = await request(app()).post("/data/rep/write").send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    expect(res.status).toBe(403);
  });

  it("write from an untrusted surface enqueues a pending write", async () => {
    const res = await request(app())
      .post("/data/ops/write")
      .set("Referer", "http://host/surfaces/d1/index.html")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(res.body.pendingId).toBe("p1");
    expect(calls).toHaveLength(0); // not executed yet
  });

  it("resolve approve executes and the surface poll then sees executed", async () => {
    const a = app();
    const w = await request(a).post("/data/ops/write")
      .set("Referer", "http://host/surfaces/d1/index.html")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    const id = w.body.pendingId;
    const r = await request(a).post(`/data/pending/${id}/resolve`).send({ decision: "approve" });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    const poll = await request(a).get(`/data/pending/${id}`);
    expect(poll.body).toEqual({ status: "executed", result: { rowCount: 1 } });
  });

  it("resolve approve with trustSurface lets the next write execute directly", async () => {
    const a = app();
    const w1 = await request(a).post("/data/ops/write")
      .set("Referer", "http://host/surfaces/d1/x").send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    await request(a).post(`/data/pending/${w1.body.pendingId}/resolve`).send({ decision: "approve", trustSurface: true });
    const w2 = await request(a).post("/data/ops/write")
      .set("Referer", "http://host/surfaces/d1/x").send({ op: { kind: "insert", table: "t", values: { a: 2 } } });
    expect(w2.status).toBe(200);
    expect(w2.body.status).toBe("executed");
  });

  it("does not leak the raw DB error message to the client on query failure", async () => {
    const secret = 'relation "secret_users" does not exist';
    const throwing: QueryExecutor = { async run() { throw new Error(secret); } };
    const router = createDataRouter({
      getSources: () => sources, getExecutor: () => throwing,
      queue: new PendingQueue({ getExecutor: () => throwing, auditPath: join(dir, "a.jsonl"), now: () => "T", id: () => "p1" }),
      trustPath: join(dir, "trust.json"), auditPath: join(dir, "a.jsonl"), now: () => "T",
      resolveToken: () => "d1",
    });
    const a = express(); a.use(express.json()); a.use("/data", router);
    const res = await request(a).post("/data/ops/query").set("X-Rhumb-Surface-Token", "x").send({ op: { kind: "select", table: "t" } });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret_users");
    expect(res.body.error).toBe("query failed");
  });

  it("does not leak the raw DB error message to the client on write failure", async () => {
    const secret = 'column "ssn" of relation "people" violates constraint';
    const throwing: QueryExecutor = { async run() { throw new Error(secret); } };
    const trustPath = join(dir, "trust.json");
    // pre-trust d1 so the write executes directly and hits the throwing executor
    const { addTrust } = await import("../src/data/trust.js");
    addTrust(trustPath, { source: "ops", surfaceId: "d1" });
    const router = createDataRouter({
      getSources: () => sources, getExecutor: () => throwing,
      queue: new PendingQueue({ getExecutor: () => throwing, auditPath: join(dir, "a.jsonl"), now: () => "T", id: () => "p1" }),
      trustPath, auditPath: join(dir, "a.jsonl"), now: () => "T",
      resolveToken: () => "d1",
    });
    const a = express(); a.use(express.json()); a.use("/data", router);
    const res = await request(a).post("/data/ops/write").set("X-Rhumb-Surface-Token", "x")
      .send({ op: { kind: "insert", table: "people", values: { ssn: "x" } } });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("ssn");
    expect(res.body.error).toBe("write failed");
  });

  it("GET /pending lists pending writes", async () => {
    const a = app();
    await request(a).post("/data/ops/write").set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    const res = await request(a).get("/data/pending");
    expect(res.body.pending).toHaveLength(1);
  });

  describe("control-token auth on the approval control plane", () => {
    const token = "operator-token";
    function guardedApp() {
      let n = 0;
      const now = () => "T";
      const getExecutor = () => executor;
      const queue = new PendingQueue({ getExecutor, auditPath: join(dir, "audit.jsonl"), now, id: () => `p${++n}` });
      const router = createDataRouter({
        getSources: () => sources, getExecutor, queue, trustPath: join(dir, "trust.json"),
        auditPath: join(dir, "audit.jsonl"), now, controlToken: token,
        resolveToken: () => "d1",
      });
      const a = express(); a.use(express.json()); a.use("/data", router);
      return a;
    }

    it("rejects GET /pending without the token", async () => {
      const res = await request(guardedApp()).get("/data/pending");
      expect(res.status).toBe(401);
    });

    it("rejects POST /pending/:id/resolve without the token", async () => {
      const res = await request(guardedApp()).post("/data/pending/p1/resolve").send({ decision: "approve" });
      expect(res.status).toBe(401);
    });

    it("leaves surface-facing query and write open (no token required)", async () => {
      const a = guardedApp();
      const q = await request(a).post("/data/ops/query").send({ op: { kind: "select", table: "t" } });
      expect(q.status).toBe(200);
      const w = await request(a).post("/data/ops/write").set("Referer", "http://h/surfaces/d1/x")
        .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
      expect(w.status).toBe(202); // enqueued for approval, not rejected
    });

    it("allows the approval control plane with the correct token", async () => {
      const a = guardedApp();
      const w = await request(a).post("/data/ops/write").set("Referer", "http://h/surfaces/d1/x")
        .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
      const r = await request(a).post(`/data/pending/${w.body.pendingId}/resolve`)
        .set("Authorization", `Bearer ${token}`).send({ decision: "approve" });
      expect(r.status).toBe(200);
    });
  });

  describe("token-based data auth", () => {
    // resolveToken maps the fixed test token to surface "d1"
    const TOKEN = "surface-d1-token";
    function tokenApp() {
      let n = 0;
      const now = () => "T";
      const getExecutor = () => executor;
      const queue = new PendingQueue({ getExecutor, auditPath: join(dir, "a.jsonl"), now, id: () => `p${++n}` });
      const router = createDataRouter({
        getSources: () => sources, getExecutor, queue, trustPath: join(dir, "trust.json"),
        auditPath: join(dir, "a.jsonl"), now,
        resolveToken: (t) => (t === TOKEN ? "d1" : null),
      });
      const a = express(); a.use(express.json()); a.use("/data", router);
      return a;
    }

    it("query without a valid surface token is 401", async () => {
      const res = await request(tokenApp()).post("/data/ops/query").send({ op: { kind: "select", table: "t" } });
      expect(res.status).toBe(401);
    });

    it("query with a valid surface token returns rows", async () => {
      const res = await request(tokenApp()).post("/data/ops/query")
        .set("X-Rhumb-Surface-Token", TOKEN).send({ op: { kind: "select", table: "t" } });
      expect(res.status).toBe(200);
    });

    it("a forged Referer without a token cannot get a direct write (it enqueues)", async () => {
      const res = await request(tokenApp()).post("/data/ops/write")
        .set("Referer", "http://h/surfaces/d1/x") // forged, no token
        .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
      expect(res.status).toBe(202); // untrusted → enqueued, not executed
    });

    it("a trusted surface writes directly when it presents its token", async () => {
      const { addTrust } = await import("../src/data/trust.js");
      addTrust(join(dir, "trust.json"), { source: "ops", surfaceId: "d1" });
      const res = await request(tokenApp()).post("/data/ops/write")
        .set("X-Rhumb-Surface-Token", TOKEN)
        .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("executed");
    });
  });
});
