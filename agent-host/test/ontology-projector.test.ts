import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSystem } from "../src/ontology/projector.js";
import { listNodes, writeNode } from "../src/ontology/vault.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-proj-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const microFacts = {
  fetchedAt: "TF",
  nodes: [{
    name: "MicroPX", status: "online", uptimeSec: 172800, cores: 8, memBytes: 16 * 2 ** 30,
    pveVersion: "pve-manager/9.0-3", cpuModel: "Intel N100",
    address: "https://192.168.1.100:8006",
    storage: [{ id: "local-lvm", usedPct: 41 }],
  }],
};

function deps(over: Partial<Parameters<typeof syncSystem>[0]> = {}) {
  return {
    config: { systemDir: dir },
    now: () => "T",
    readDataSources: () => [{ id: "ops", type: "postgres", mode: "read-write" }],
    readServices: () => [{ id: "demo", name: "Demo", containerId: 105, host: "h", port: 8080, status: "healthy" }],
    readSurfaceIds: () => ["report"],
    readDataAudit: () => [{ surfaceId: "report", source: "ops", op: { kind: "select" } }],
    readInfraAudit: () => [{ ts: "T", tool: "mcp__infra__create_vm", input: { name: "build" }, decision: "approved" }],
    readNodeFacts: () => null,
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

  it("projects a PVE node with props and roots containers and vms on it", () => {
    syncSystem(deps({ readNodeFacts: () => microFacts }));
    const byId = Object.fromEntries(listNodes(dir).map((n) => [n.id, n]));
    expect(byId["node-MicroPX"]).toBeTruthy();
    expect(byId["node-MicroPX"].props).toMatchObject({
      status: "online", factsAsOf: "TF", pveVersion: "pve-manager/9.0-3", cpuModel: "Intel N100",
      cores: "8", memoryGb: "16", uptimeDays: "2", address: "https://192.168.1.100:8006",
      storage_local_lvm: "41% used",
    });
    expect(byId["container-105"].relationships).toContainEqual({ edge: "runs-on", target: "node-MicroPX" });
    expect(byId["vm-build"].relationships).toContainEqual({ edge: "runs-on", target: "node-MicroPX" });
  });

  it("skips runs-on edges when more than one node exists (placement unknown)", () => {
    const twoNodes = { fetchedAt: "TF", nodes: [microFacts.nodes[0], { ...microFacts.nodes[0], name: "Second" }] };
    syncSystem(deps({ readNodeFacts: () => twoNodes }));
    const byId = Object.fromEntries(listNodes(dir).map((n) => [n.id, n]));
    expect(byId["node-MicroPX"]).toBeTruthy();
    expect(byId["node-Second"]).toBeTruthy();
    expect(byId["container-105"].relationships.some((r) => r.edge === "runs-on" && r.target.startsWith("node-"))).toBe(false);
  });

  it("projects no node when facts are absent", () => {
    syncSystem(deps());
    expect(listNodes(dir).some((n) => n.type === "node")).toBe(false);
  });

  it("is idempotent and removes stale system nodes", () => {
    writeNode(dir, { type: "vm", id: "vm-old", title: "old", managed: "system", props: {}, relationships: [] });
    const r = syncSystem(deps({ readInfraAudit: () => [] })); // no vms this time → vm-old is stale
    expect(listNodes(dir).some((n) => n.id === "vm-old")).toBe(false);
    expect(r.removed).toBeGreaterThanOrEqual(1);
  });
});
