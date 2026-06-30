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
    sources, getExecutor, queue, trustPath: join(dir, "trust.json"), auditPath: join(dir, "audit.jsonl"), now,
  });
  const a = express();
  a.use(express.json());
  a.use("/data", router);
  return a;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-dr-")); calls = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("data router", () => {
  it("query runs a select and returns rows", async () => {
    const res = await request(app()).post("/data/ops/query").send({ op: { kind: "select", table: "t", where: { id: 1 } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [{ id: 1 }] });
    expect(calls[0].text).toContain("SELECT");
  });

  it("query rejects a non-select op", async () => {
    const res = await request(app()).post("/data/ops/query").send({ op: { kind: "delete", table: "t", where: { id: 1 } } });
    expect(res.status).toBe(400);
  });

  it("query 404s an unknown source", async () => {
    const res = await request(app()).post("/data/missing/query").send({ op: { kind: "select", table: "t" } });
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

  it("GET /pending lists pending writes", async () => {
    const a = app();
    await request(a).post("/data/ops/write").set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    const res = await request(a).get("/data/pending");
    expect(res.body.pending).toHaveLength(1);
  });
});
