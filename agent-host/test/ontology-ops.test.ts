import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOntologyOps, ONTOLOGY_TOOL_NAMES } from "../src/ontology/ops.js";
import { writeNode } from "../src/ontology/vault.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-ops-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function ops() {
  const systemDir = join(dir, "system");
  const domainDir = join(dir, "domain");
  return createOntologyOps({
    systemDir, domainDir, now: () => "T",
    sync: () => ({ added: 1, updated: 0, removed: 0 }),
  });
}

describe("ontology ops", () => {
  it("upserts a domain node and queries it by type", () => {
    const o = ops();
    o.upsert({ id: "customer-1", title: "Acme", subtype: "customer", props: { tier: "gold" } });
    expect(o.query({ kind: "type", type: "entity" })).toMatchObject([{ id: "customer-1", managed: "domain" }]);
    expect(o.query({ kind: "node", id: "customer-1" })).toMatchObject({ props: { subtype: "customer", tier: "gold" } });
  });

  it("links from a domain node and resolves the reverse neighbor", () => {
    const o = ops();
    // pretend a system datasource exists
    writeNode(join(dir, "system"), { type: "datasource", id: "datasource-ops", title: "ops", managed: "system", props: {}, relationships: [] });
    o.upsert({ id: "customer-1", title: "Acme", subtype: "customer" });
    o.link("customer-1", "stored-in", "datasource-ops");
    const inbound = o.query({ kind: "neighbors", id: "datasource-ops", direction: "in" }) as Array<{ node: { id: string } }>;
    expect(inbound.map((x) => x.node.id)).toEqual(["customer-1"]);
  });

  it("refuses to author an edge from a system node", () => {
    const o = ops();
    writeNode(join(dir, "system"), { type: "vm", id: "vm-build", title: "build", managed: "system", props: {}, relationships: [] });
    expect(() => o.link("vm-build", "supports", "customer-1")).toThrow(/domain/);
  });

  it("exposes four allowlisted tool names", () => {
    expect([...ONTOLOGY_TOOL_NAMES].sort()).toEqual(
      ["mcp__ontology__link", "mcp__ontology__query", "mcp__ontology__sync", "mcp__ontology__upsert_node"].sort(),
    );
  });

  it("rejects a domain id that uses a reserved system prefix", () => {
    const o = ops();
    expect(() => o.upsert({ id: "service-demo", title: "X" })).toThrow(/reserved/);
    expect(() => o.upsert({ id: "datasource-ops", title: "X" })).toThrow(/reserved/);
  });

  it("rejects newlines in title or prop values (frontmatter injection)", () => {
    const o = ops();
    expect(() => o.upsert({ id: "customer-2", title: "a\nmanaged: system" })).toThrow(/newline/);
    expect(() => o.upsert({ id: "customer-2", title: "ok", props: { x: "a\nb" } })).toThrow(/newline/);
  });
});

describe("ontology ops read side", () => {
  it("list() returns system and domain nodes merged", () => {
    const o = ops();
    writeNode(join(dir, "system"), { type: "service", id: "service-x", title: "X", managed: "system", props: {}, relationships: [] });
    o.upsert({ id: "customer-1", title: "Acme" });
    expect(o.list().map((n) => n.id).sort()).toEqual(["customer-1", "service-x"]);
  });

  it("status() starts empty, records a successful sync, and records a failure", () => {
    const systemDir = join(dir, "system");
    const domainDir = join(dir, "domain");
    let fail = false;
    const o = createOntologyOps({
      systemDir, domainDir, now: () => "T1",
      sync: () => { if (fail) throw new Error("boom"); return { added: 0, updated: 0, removed: 0 }; },
    });
    expect(o.status()).toEqual({ syncedAt: null, syncError: null });
    o.sync();
    expect(o.status()).toEqual({ syncedAt: "T1", syncError: null });
    fail = true;
    expect(() => o.sync()).toThrow("boom");
    expect(o.status()).toEqual({ syncedAt: "T1", syncError: "boom" });
    fail = false;
    o.sync();
    expect(o.status().syncError).toBeNull();
  });
});
