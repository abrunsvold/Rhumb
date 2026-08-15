import { describe, it, expect, vi } from "vitest";
import { createOntologyServer } from "../src/ontology/server.js";
import type { OntologyOps, OntologyQuery } from "../src/ontology/ops.js";

// Drives the registered MCP tool handler directly, the same way
// infra-server.test.ts does. This layer had no test coverage at all: every
// other ontology test calls ops.query() with a hand-built argument object,
// which is precisely the step this handler was getting wrong.
function harness(overrides: Partial<OntologyOps> = {}) {
  const seen: OntologyQuery[] = [];
  const ops: OntologyOps = {
    sync: () => ({ added: 0, updated: 0, removed: 0 }),
    list: () => [],
    status: () => ({ syncedAt: null, syncError: null }),
    query: (q) => {
      seen.push(q);
      return { got: q };
    },
    upsert: vi.fn() as unknown as OntologyOps["upsert"],
    link: vi.fn() as unknown as OntologyOps["link"],
    ...overrides,
  };
  const server = createOntologyServer(ops);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registered = (server.instance as any)._registeredTools;
  return {
    seen,
    async query(args: Record<string, unknown>) {
      const r = await registered.query.handler(args, {});
      return {
        isError: Boolean(r.isError),
        text: r.content.map((c: { text: string }) => c.text).join("\n"),
      };
    },
  };
}

describe("ontology MCP query tool", () => {
  it("refuses kind=node with no id instead of answering null", async () => {
    const h = harness();
    const r = await h.query({ kind: "node" });
    expect(r.isError).toBe(true);
    // The refusal must never reach ops — a missing selector is not a query.
    expect(h.seen).toEqual([]);
  });

  it("refuses kind=type with no type", async () => {
    const h = harness();
    const r = await h.query({ kind: "type" });
    expect(r.isError).toBe(true);
    expect(h.seen).toEqual([]);
  });

  it("refuses kind=neighbors with no id", async () => {
    const h = harness();
    const r = await h.query({ kind: "neighbors" });
    expect(r.isError).toBe(true);
    expect(h.seen).toEqual([]);
  });

  // The defect that made the live watchdog report an empty inventory against a
  // populated vault: `kind` accepts "node" AND the projector emits nodes whose
  // `type` is "node", so asking for "the node-type nodes" is a natural thing to
  // type. The handler used to discard `type` and look up getNode("").
  it("refuses kind=node with only a type, and names the shape that works", async () => {
    const h = harness();
    const r = await h.query({ kind: "node", type: "service" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('kind="type"');
    expect(h.seen).toEqual([]);
  });

  it("still answers a well-formed node query", async () => {
    const h = harness();
    const r = await h.query({ kind: "node", id: "service-api" });
    expect(r.isError).toBe(false);
    expect(h.seen).toEqual([{ kind: "node", id: "service-api" }]);
  });

  it("still answers a well-formed type query", async () => {
    const h = harness();
    const r = await h.query({ kind: "type", type: "service" });
    expect(r.isError).toBe(false);
    expect(h.seen).toEqual([{ kind: "type", type: "service" }]);
  });

  it("still answers a well-formed neighbors query, passing edge and direction", async () => {
    const h = harness();
    const r = await h.query({ kind: "neighbors", id: "dashboard-farm", edge: "uses", direction: "out" });
    expect(r.isError).toBe(false);
    expect(h.seen).toEqual([{ kind: "neighbors", id: "dashboard-farm", edge: "uses", direction: "out" }]);
  });
});
