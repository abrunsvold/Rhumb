import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceOps } from "../src/services/ops.js";
import { loadServices, appendService, removeService } from "../src/services/registry.js";
import type { LxcClient, ServiceDeployer, ServiceConfig, ServiceManifest } from "../src/services/types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumbr-svc-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function cfg(): ServiceConfig {
  return { deployKeyPath: "/k", deployPublicKey: "pub", ostemplate: "t", storage: "s", bridge: "b", rootfsGb: 8, servicesPath: join(dir, "services.json"), workspace: dir };
}
const manifest = (id: string): ServiceManifest => ({ id, type: "service", name: id, start: "run", port: 3000 });

describe("registry", () => {
  it("append dedups by id, remove drops, corrupt→[]", () => {
    const p = join(dir, "s.json");
    const e = { id: "a", name: "a", containerId: 1, host: "h", port: 3000, basePath: "/services/a", status: "healthy" as const, createdAt: "t" };
    expect(appendService(p, e)).toHaveLength(1);
    expect(appendService(p, e)).toHaveLength(1);
    expect(removeService(p, "a")).toHaveLength(0);
    expect(loadServices(join(dir, "missing.json"))).toEqual([]);
  });
});

describe("createServiceOps.spawn", () => {
  function fakes(overrides: Partial<LxcClient> = {}) {
    const calls: string[] = [];
    const lxc: LxcClient = {
      async create(s) { calls.push(`create:${s.name}`); return { id: 200 }; },
      async start(id) { calls.push(`start:${id}`); },
      async stop(id) { calls.push(`stop:${id}`); },
      async destroy(id) { calls.push(`destroy:${id}`); },
      async status(id) { return { id, status: "running" }; },
      async ip() { return "10.0.0.9"; },
      ...overrides,
    };
    const deployed: string[] = [];
    const deployer: ServiceDeployer = { async deploy(_t, dirArg, m) { deployed.push(`${m.id}@${dirArg}`); } };
    return { calls, deployer, deployed, lxc };
  }

  it("creates, awaits IP, deploys, and registers", async () => {
    const { calls, deployer, deployed, lxc } = fakes();
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T", readManifest: manifest, sleep: async () => {} });
    const entry = await ops.spawn("sales");
    expect(entry).toMatchObject({ id: "sales", containerId: 200, host: "10.0.0.9", port: 3000, basePath: "/services/sales", status: "healthy" });
    expect(calls).toEqual(["create:sales", "start:200"]);
    expect(deployed).toEqual([`sales@${join(dir, "services", "sales")}`]);
    expect(loadServices(cfg().servicesPath).map((s) => s.id)).toEqual(["sales"]);
  });

  it("rolls back (destroys the container) if deploy fails", async () => {
    const { calls, lxc } = fakes();
    const badDeployer: ServiceDeployer = { async deploy() { throw new Error("scp failed"); } };
    const ops = createServiceOps({ lxc, deployer: badDeployer, config: cfg(), now: () => "T", readManifest: manifest, sleep: async () => {} });
    await expect(ops.spawn("sales")).rejects.toThrow(/scp failed/);
    expect(calls).toContain("destroy:200");
    expect(loadServices(cfg().servicesPath)).toEqual([]);
  });

  it("destroy stops+destroys the container and deregisters", async () => {
    const { calls, deployer, lxc } = fakes();
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T", readManifest: manifest, sleep: async () => {} });
    await ops.spawn("sales");
    await ops.destroy("sales");
    expect(calls).toContain("destroy:200");
    expect(loadServices(cfg().servicesPath)).toEqual([]);
  });
});
