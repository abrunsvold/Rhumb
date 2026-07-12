import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFactsRefresher, readNodeFactsFile, type NodeFacts } from "../src/infra/nodeFacts.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-facts-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const fixtures: Record<string, unknown> = {
  "/nodes": [{ node: "MicroPX", status: "online", uptime: 86400, maxcpu: 8, maxmem: 16_000_000_000 }],
  "/nodes/MicroPX/status": { pveversion: "pve-manager/9.0-3", cpuinfo: { model: "Intel N100" } },
  "/nodes/MicroPX/storage": [
    { storage: "local-lvm", used: 41, total: 100 },
    { storage: "no-total" },
  ],
  "/cluster/resources?type=vm": [
    { vmid: 105, node: "MicroPX", name: "printer-poller", type: "lxc" },
    { vmid: 200, node: "pnp", name: "build", type: "qemu" },
  ],
};

function refresher(call: (m: string, p: string) => Promise<unknown>, path: string) {
  return createNodeFactsRefresher({ call, address: "https://192.168.1.100:8006", path, now: () => "T1" });
}

describe("createNodeFactsRefresher", () => {
  it("fetches node, status, and storage and writes the facts file", async () => {
    const path = join(dir, "node-facts.json");
    const facts = await refresher(async (_m, p) => fixtures[p], path)();
    expect(facts.fetchedAt).toBe("T1");
    expect(facts.nodes).toEqual([{
      name: "MicroPX", status: "online", uptimeSec: 86400, cores: 8, memBytes: 16_000_000_000,
      pveVersion: "pve-manager/9.0-3", cpuModel: "Intel N100",
      address: "https://192.168.1.100:8006",
      storage: [{ id: "local-lvm", usedPct: 41 }],
    }]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(facts);
  });

  it("maps guest placements from /cluster/resources", async () => {
    const path = join(dir, "node-facts.json");
    const facts = await refresher(async (_m, p) => fixtures[p], path)();
    expect(facts.placements).toEqual({
      byVmid: { "105": "MicroPX", "200": "pnp" },
      byName: { "printer-poller": "MicroPX", build: "pnp" },
    });
  });

  it("omits placements when the cluster resources call fails", async () => {
    const path = join(dir, "node-facts.json");
    const call = async (_m: string, p: string) => {
      if (p.startsWith("/cluster/")) throw new Error("boom");
      return fixtures[p];
    };
    const facts = await refresher(call, path)();
    expect(facts.placements).toBeUndefined();
    expect(facts.nodes).toHaveLength(1);
  });

  it("degrades per-node when status/storage sub-calls fail", async () => {
    const path = join(dir, "node-facts.json");
    const call = async (_m: string, p: string) => {
      if (p === "/nodes") return fixtures["/nodes"];
      throw new Error("boom");
    };
    const facts = await refresher(call, path)();
    expect(facts.nodes[0].name).toBe("MicroPX");
    expect(facts.nodes[0].pveVersion).toBeUndefined();
    expect(facts.nodes[0].storage).toEqual([]);
  });

  it("rejects when the node listing itself fails (caller treats refresh as best-effort)", async () => {
    const path = join(dir, "node-facts.json");
    await expect(refresher(async () => { throw new Error("pve down"); }, path)()).rejects.toThrow("pve down");
  });
});

describe("readNodeFactsFile", () => {
  it("returns null for missing or corrupt files and parses valid ones", () => {
    const path = join(dir, "node-facts.json");
    expect(readNodeFactsFile(path)).toBeNull();
    writeFileSync(path, "{not json");
    expect(readNodeFactsFile(path)).toBeNull();
    const facts: NodeFacts = { fetchedAt: "T", nodes: [] };
    writeFileSync(path, JSON.stringify(facts));
    expect(readNodeFactsFile(path)).toEqual(facts);
  });
});
