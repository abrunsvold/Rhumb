import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeNode, parseNode, writeNode, readNode, listNodes } from "../src/ontology/vault.js";
import { loadOntologyConfig } from "../src/ontology/config.js";
import type { OntologyNode } from "../src/ontology/types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-onto-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const node: OntologyNode = {
  type: "service", id: "service-demo", title: "Demo", managed: "system",
  created: "T", updated: "T", props: { port: "8080", status: "healthy" },
  relationships: [{ edge: "runs-on", target: "container-105" }, { edge: "created-by", target: "agent" }],
};

describe("vault serialize/parse round-trip", () => {
  it("round-trips a node through markdown", () => {
    const md = serializeNode(node);
    expect(md).toContain("type: service");
    expect(md).toContain("port: 8080");
    expect(md).toContain("- runs-on [[container-105]]");
    const back = parseNode(md);
    expect(back).toEqual(node);
  });

  it("parse returns null on a file without frontmatter", () => {
    expect(parseNode("no frontmatter here")).toBeNull();
    expect(parseNode("---\nnoid: x\n---\n")).toBeNull(); // missing required id/type
  });
});

describe("vault read/write/list", () => {
  it("writes to <dir>/<id>.md and lists them back", () => {
    writeNode(dir, node);
    expect(readNode(join(dir, "service-demo.md"))).toEqual(node);
    writeNode(dir, { ...node, id: "datasource-ops", type: "datasource" });
    expect(listNodes(dir).map((n) => n.id).sort()).toEqual(["datasource-ops", "service-demo"]);
  });

  it("listNodes skips malformed files and a missing dir returns []", () => {
    expect(listNodes(join(dir, "nope"))).toEqual([]);
  });
});

describe("loadOntologyConfig", () => {
  it("derives vault + artifact paths under the workspace", () => {
    const c = loadOntologyConfig({ RHUMB_WORKSPACE: "/srv/ws" });
    expect(c.vaultPath).toBe("/srv/ws/ontology");
    expect(c.systemDir).toBe("/srv/ws/ontology/system");
    expect(c.domainDir).toBe("/srv/ws/ontology/domain");
    expect(c.servicesPath).toBe("/srv/ws/services.json");
    expect(c.dataSourcesPath).toBe("/srv/ws/data-sources.json");
    expect(c.surfacesDir).toBe("/srv/ws/surfaces");
    expect(c.infraAuditPath).toBe("/srv/ws/infra-audit.jsonl");
  });
});
