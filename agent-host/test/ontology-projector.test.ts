import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSystem } from "../src/ontology/projector.js";
import { listNodes, writeNode } from "../src/ontology/vault.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-proj-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function deps(over: Partial<Parameters<typeof syncSystem>[0]> = {}) {
  return {
    config: { systemDir: dir },
    now: () => "T",
    readDataSources: () => [{ id: "ops", type: "postgres", mode: "read-write" }],
    readServices: () => [{ id: "demo", name: "Demo", containerId: 105, host: "h", port: 8080, status: "healthy" }],
    readSurfaceIds: () => ["report"],
    readDataAudit: () => [{ surfaceId: "report", source: "ops", op: { kind: "select" } }],
    readInfraAudit: () => [{ ts: "T", tool: "mcp__infra__create_vm", input: { name: "build" }, decision: "approved" }],
    ...over,
  };
}

describe("syncSystem", () => {
  it("projects datasource, service+container+runs-on, dashboard, vm, and reads-from edges", () => {
    syncSystem(deps());
    const nodes = listNodes(dir);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(Object.keys(byId).sort()).toEqual(
      ["container-105", "dashboard-report", "datasource-ops", "service-demo", "vm-build"].sort(),
    );
    expect(byId["service-demo"].relationships).toContainEqual({ edge: "runs-on", target: "container-105" });
    expect(byId["dashboard-report"].relationships).toContainEqual({ edge: "reads-from", target: "datasource-ops" });
    // no connection string leaked
    expect(JSON.stringify(byId["datasource-ops"])).not.toContain("connectionString");
    expect(byId["datasource-ops"].props).toMatchObject({ mode: "read-write" });
  });

  it("is idempotent and removes stale system nodes", () => {
    writeNode(dir, { type: "vm", id: "vm-old", title: "old", managed: "system", props: {}, relationships: [] });
    const r = syncSystem(deps({ readInfraAudit: () => [] })); // no vms this time → vm-old is stale
    expect(listNodes(dir).some((n) => n.id === "vm-old")).toBe(false);
    expect(r.removed).toBeGreaterThanOrEqual(1);
  });
});
