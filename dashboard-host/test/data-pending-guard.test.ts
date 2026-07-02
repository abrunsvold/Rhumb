import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createDataRouter } from "../src/data/router.js";
import { requireShellHeader } from "../src/identity.js";
import { PendingQueue } from "../src/data/writes.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  const queue = new PendingQueue({
    getExecutor: () => ({ async run() { return { rows: [], rowCount: 0 }; } }),
    auditPath: "/tmp/rhumb-guard-audit.jsonl",
    now: () => "t",
    id: () => "p1",
  });
  app.use(
    "/data",
    createDataRouter({
      getSources: () => [],
      getExecutor: () => ({ async run() { return { rows: [], rowCount: 0 }; } }),
      queue,
      trustPath: "/tmp/rhumb-guard-trust.json",
      auditPath: "/tmp/rhumb-guard-audit.jsonl",
      now: () => "t",
      pendingGuard: requireShellHeader(),
      resolveToken: () => null,
    }),
  );
  return app;
}

describe("pending approval plane", () => {
  it("rejects /data/pending without the shell header (a surface can never set Sec-*)", async () => {
    expect((await request(makeApp()).get("/data/pending")).status).toBe(403);
  });

  it("serves /data/pending with the shell header", async () => {
    const res = await request(makeApp()).get("/data/pending").set("Sec-Rhumb-Control", "1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: [] });
  });
});
