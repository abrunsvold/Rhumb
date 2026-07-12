import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createOntologyRouter } from "../src/ontology/router.js";
import type { OntologyOps } from "../src/ontology/ops.js";

function app(ops: OntologyOps) {
  const a = express();
  a.use("/ontology", createOntologyRouter({ ops }));
  return a;
}

const node = { type: "service", id: "service-x", title: "X", managed: "system" as const, props: {}, relationships: [] };

describe("GET /ontology", () => {
  it("syncs on read and returns nodes with sync status", async () => {
    const sync = vi.fn(() => ({ added: 0, updated: 1, removed: 0 }));
    const ops = {
      sync, list: () => [node], status: () => ({ syncedAt: "T1", syncError: null }),
      query: () => null, upsert: () => node, link: () => node,
    } as unknown as OntologyOps;
    const res = await request(app(ops)).get("/ontology");
    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledOnce();
    expect(res.body).toEqual({ nodes: [node], syncedAt: "T1", syncError: null });
  });

  it("degrades to last-good nodes when sync throws", async () => {
    const ops = {
      sync: () => { throw new Error("projector broke"); },
      list: () => [node], status: () => ({ syncedAt: "T0", syncError: "projector broke" }),
      query: () => null, upsert: () => node, link: () => node,
    } as unknown as OntologyOps;
    const res = await request(app(ops)).get("/ontology");
    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.syncError).toBe("projector broke");
    expect(res.body.syncedAt).toBe("T0");
  });
});
