import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createInfraRouter } from "../src/infra/router.js";
import { PendingActions } from "../src/infra/pending.js";

function app(pending: PendingActions) {
  const a = express();
  a.use(express.json());
  a.use("/infra", createInfraRouter({ pending }));
  return a;
}

describe("infra router", () => {
  it("GET /pending lists pending actions", async () => {
    let n = 0;
    const pending = new PendingActions({ now: () => "T", id: () => `a${++n}` });
    pending.enqueue("destroy_vm", { id: 9 });
    const res = await request(app(pending)).get("/infra/pending");
    expect(res.status).toBe(200);
    expect(res.body.pending).toHaveLength(1);
    expect(res.body.pending[0].tool).toBe("destroy_vm");
  });

  it("POST /pending/:id/resolve resolves a pending action", async () => {
    let n = 0;
    const pending = new PendingActions({ now: () => "T", id: () => `a${++n}` });
    const { decision } = pending.enqueue("create_vm", { name: "x" });
    const res = await request(app(pending)).post("/infra/pending/a1/resolve").send({ decision: "approve" });
    expect(res.status).toBe(200);
    expect(await decision).toBe("approve");
  });

  it("rejects a bad decision and an unknown id", async () => {
    const pending = new PendingActions({ now: () => "T", id: () => "a1" });
    expect((await request(app(pending)).post("/infra/pending/a1/resolve").send({ decision: "maybe" })).status).toBe(400);
    expect((await request(app(pending)).post("/infra/pending/missing/resolve").send({ decision: "approve" })).status).toBe(404);
  });
});
