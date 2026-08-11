import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync, readFileSync, existsSync as existsSyncFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataRouter } from "../src/data/router.js";
import { PendingQueue } from "../src/data/writes.js";
import type { QueryExecutor, DataSource } from "../src/data/types.js";
import { createControlTokenGuard } from "../src/auth.js";

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
    pendingGuard: createControlTokenGuard(undefined),
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
      pendingGuard: createControlTokenGuard(undefined),
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
      pendingGuard: createControlTokenGuard(undefined),
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

  it("a trusted surface's executed write is audited with auth:trust", async () => {
    const { addTrust } = await import("../src/data/trust.js");
    addTrust(join(dir, "trust.json"), { source: "ops", surfaceId: "d1" });
    const a = app();
    const w = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    expect(w.body.status).toBe("executed");
    const line = JSON.parse(readFileSync(join(dir, "audit.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ decision: "executed", auth: "trust" });
  });

  it("an operator-approved write is audited with auth:approval", async () => {
    const a = app();
    const w = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    await request(a).post(`/data/pending/${w.body.pendingId}/resolve`).send({ decision: "approve" });
    const line = JSON.parse(readFileSync(join(dir, "audit.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ decision: "executed", auth: "approval" });
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
        auditPath: join(dir, "audit.jsonl"), now,
        pendingGuard: createControlTokenGuard(token),
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

    it("the control-token guard does not block surface query or write", async () => {
      const a = guardedApp();
      const q = await request(a).post("/data/ops/query").set("X-Rhumb-Surface-Token", "x").send({ op: { kind: "select", table: "t" } });
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
        pendingGuard: createControlTokenGuard(undefined),
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

  it("a trusted surface's DELETE re-gates (enqueues) instead of auto-executing", async () => {
    const { addTrust } = await import("../src/data/trust.js");
    addTrust(join(dir, "trust.json"), { source: "ops", surfaceId: "d1" });
    const a = app();
    const res = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "delete", table: "t", where: { id: 1 } } });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(calls).toHaveLength(0); // not executed under trust
  });

  it("a trusted surface's INSERT and UPDATE still auto-execute", async () => {
    const { addTrust } = await import("../src/data/trust.js");
    addTrust(join(dir, "trust.json"), { source: "ops", surfaceId: "d1" });
    const a = app();
    const ins = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    expect(ins.body.status).toBe("executed");
    const upd = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "update", table: "t", where: { id: 1 }, values: { a: 2 } } });
    expect(upd.body.status).toBe("executed");
  });

  it("a re-gated trusted DELETE audits as auth:approval once approved", async () => {
    const { addTrust } = await import("../src/data/trust.js");
    addTrust(join(dir, "trust.json"), { source: "ops", surfaceId: "d1" });
    const a = app();
    const w = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "delete", table: "t", where: { id: 1 } } });
    await request(a).post(`/data/pending/${w.body.pendingId}/resolve`).send({ decision: "approve" });
    const line = JSON.parse(readFileSync(join(dir, "audit.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ decision: "executed", op: { kind: "delete" }, auth: "approval" });
  });

  describe("concurrent resolution of one pending write", () => {
    // A gated executor holds the write's `run()` in flight so two concurrent
    // /resolve requests genuinely race against the same in-memory entry,
    // reproducing the two-approvers-execute-twice bug the fix closes.
    function gatedApp() {
      let releaseRun!: () => void;
      const gate = new Promise<void>((r) => { releaseRun = r; });
      const runCalls: unknown[] = [];
      const gatedExecutor: QueryExecutor = {
        async run(sql) {
          runCalls.push(sql);
          await gate;
          return { rows: [], rowCount: 1 };
        },
      };
      const auditPath = join(dir, "audit.jsonl");
      const queue = new PendingQueue({ getExecutor: () => gatedExecutor, auditPath, now: () => "T", id: () => "p1" });
      const router = createDataRouter({
        getSources: () => sources, getExecutor: () => gatedExecutor, queue,
        trustPath: join(dir, "trust.json"), auditPath, now: () => "T",
        pendingGuard: createControlTokenGuard(undefined),
        resolveToken: () => "d1",
        actorOf: (req) => req.get("tailscale-user-login") ?? "",
      });
      const a = express(); a.use(express.json()); a.use("/data", router);
      return { a, auditPath, runCalls, release: () => releaseRun() };
    }

    it("executes exactly once and produces exactly one executed audit entry; the loser gets 409", async () => {
      const { a, auditPath, runCalls, release } = gatedApp();
      const w = await request(a).post("/data/ops/write")
        .set("Referer", "http://h/surfaces/d1/x")
        .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
      const id = w.body.pendingId;

      // Both approvals reach the gated executor before either resolves.
      const p1 = request(a).post(`/data/pending/${id}/resolve`)
        .set("Tailscale-User-Login", "first@example.com")
        .send({ decision: "approve" });
      const p2 = request(a).post(`/data/pending/${id}/resolve`)
        .set("Tailscale-User-Login", "second@example.com")
        .send({ decision: "approve" });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      release();
      const [r1, r2] = await Promise.all([p1, p2]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = r1.status === 409 ? r1 : r2;
      const winnerLogin = r1.status === 200 ? "first@example.com" : "second@example.com";
      expect(loser.body.error).toBe("already resolved");
      // The loser races the winner's still-in-flight DB round trip, so the
      // winner's login must already be on the synchronous "executing" record —
      // a bare `by: ""` tells the loser nothing (review F5).
      expect(loser.body.by).toBe(winnerLogin);

      expect(runCalls).toHaveLength(1); // the write ran exactly once

      const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.filter((l) => l.decision === "executed")).toHaveLength(1);
    });

    it("an approve/deny interleaving does not audit a denied write that already executed", async () => {
      const { a, auditPath, release } = gatedApp();
      const w = await request(a).post("/data/ops/write")
        .set("Referer", "http://h/surfaces/d1/x")
        .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
      const id = w.body.pendingId;

      const pApprove = request(a).post(`/data/pending/${id}/resolve`).send({ decision: "approve" });
      const pDeny = request(a).post(`/data/pending/${id}/resolve`).send({ decision: "deny" });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      release();
      const [rApprove, rDeny] = await Promise.all([pApprove, pDeny]);

      expect(rApprove.status).toBe(200);
      expect(rDeny.status).toBe(409);

      const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.filter((l) => l.decision === "executed")).toHaveLength(1);
      expect(lines.filter((l) => l.decision === "denied")).toHaveLength(0);
    });

    it("an unknown pending id still 404s", async () => {
      const { a } = gatedApp();
      const res = await request(a).post("/data/pending/nope/resolve").send({ decision: "approve" });
      expect(res.status).toBe(404);
    });

    // Deliberate (review F7): the 409 loser's trust checkbox creates NO grant.
    // Their approval never happened, and a standing auto-execute rule must
    // ride on an approval that did. The client mirrors this by dropping the
    // trust intent when it reports "Already approved by …".
    it("does not grant trust for the loser of a resolve race, even when their approve carried it", async () => {
      const { a, release } = gatedApp();
      const trustPath = join(dir, "trust.json");
      const w = await request(a).post("/data/ops/write")
        .set("Referer", "http://h/surfaces/d1/x")
        .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
      const id = w.body.pendingId;

      const pWin = request(a).post(`/data/pending/${id}/resolve`)
        .set("Tailscale-User-Login", "first@example.com")
        .send({ decision: "approve" });
      await new Promise((r) => setImmediate(r));
      const pLose = request(a).post(`/data/pending/${id}/resolve`)
        .set("Tailscale-User-Login", "second@example.com")
        .send({ decision: "approve", trustSurface: true });
      await new Promise((r) => setImmediate(r));

      release();
      const [rWin, rLose] = await Promise.all([pWin, pLose]);
      expect(rWin.status).toBe(200);
      expect(rLose.status).toBe(409);

      // The winner did not ask for trust and the loser's ask must not count.
      expect(existsSyncFs(trustPath)).toBe(false);
    });
  });

  it("attributes a resolved write to the Tailscale-User-Login header (F5)", async () => {
    const auditPath = join(dir, "audit.jsonl");
    let n = 0;
    const now = () => "T";
    const getExecutor = () => executor;
    const queue = new PendingQueue({ getExecutor, auditPath, now, id: () => `p${++n}` });
    const router = createDataRouter({
      getSources: () => sources, getExecutor, queue,
      trustPath: join(dir, "trust.json"), auditPath, now,
      pendingGuard: createControlTokenGuard(undefined),
      resolveToken: () => "d1",
      actorOf: (req) => req.get("tailscale-user-login") ?? "",
    });
    const a = express(); a.use(express.json()); a.use("/data", router);

    const w = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    const res = await request(a)
      .post(`/data/pending/${w.body.pendingId}/resolve`)
      .set("Tailscale-User-Login", "op@example.com")
      .send({ decision: "approve" });

    expect(res.status).toBe(200);
    const line = JSON.parse(readFileSync(auditPath, "utf8").trim());
    expect(line).toMatchObject({ decision: "executed", auth: "approval", actor: "op@example.com" });
  });

  it("records who granted trust, and audits the grant (review F3)", async () => {
    const auditPath = join(dir, "audit.jsonl");
    const trustPath = join(dir, "trust.json");
    let n = 0;
    const queue = new PendingQueue({ getExecutor: () => executor, auditPath, now: () => "T", id: () => `p${++n}` });
    const router = createDataRouter({
      getSources: () => sources, getExecutor: () => executor, queue,
      trustPath, auditPath, now: () => "T",
      pendingGuard: createControlTokenGuard(undefined),
      resolveToken: () => "d1",
      actorOf: (req) => req.get("tailscale-user-login") ?? "",
    });
    const a = express(); a.use(express.json()); a.use("/data", router);

    const w = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    const res = await request(a)
      .post(`/data/pending/${w.body.pendingId}/resolve`)
      .set("Tailscale-User-Login", "zoe@example.com")
      .send({ decision: "approve", trustSurface: true });
    expect(res.status).toBe(200);

    // The standing rule itself names its granter: in a shared room, "someone
    // trusted this surface" has to answer WHO, or every later auth:"trust"
    // write is untraceable to the human decision that allowed it.
    const pairs = JSON.parse(readFileSync(trustPath, "utf8"));
    expect(pairs).toEqual([
      { source: "ops", surfaceId: "d1", grantedBy: "zoe@example.com", grantedAt: "T" },
    ]);

    // …and the grant leaves an audit line of its own, like every other
    // trust-model decision.
    const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const grant = lines.find((l) => l.decision === "trust-granted");
    expect(grant).toMatchObject({ source: "ops", surfaceId: "d1", actor: "zoe@example.com" });
  });

  it("still auto-executes on a grant recorded before granter attribution existed", async () => {
    const auditPath = join(dir, "audit.jsonl");
    const trustPath = join(dir, "trust.json");
    // A pre-F3 trust.json pair: no grantedBy/grantedAt.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(trustPath, JSON.stringify([{ source: "ops", surfaceId: "d1" }]));
    let n = 0;
    const queue = new PendingQueue({ getExecutor: () => executor, auditPath, now: () => "T", id: () => `p${++n}` });
    const router = createDataRouter({
      getSources: () => sources, getExecutor: () => executor, queue,
      trustPath, auditPath, now: () => "T",
      pendingGuard: createControlTokenGuard(undefined),
      resolveToken: () => "d1",
    });
    const a = express(); a.use(express.json()); a.use("/data", router);

    const res = await request(a).post("/data/ops/write")
      .set("Referer", "http://h/surfaces/d1/x")
      .send({ op: { kind: "insert", table: "t", values: { a: 1 } } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("executed");
  });
});
