import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceOps } from "../src/services/ops.js";
import { loadServices, appendService, removeService } from "../src/services/registry.js";
import type { LxcClient, ServiceDeployer, ServiceConfig, ServiceManifest } from "../src/services/types.js";
import type { HealthGate } from "../src/services/health.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rhumb-svc-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function cfg(): ServiceConfig {
  return { deployKeyPath: "/k", deployPublicKey: "pub", ostemplate: "t", storage: "s", bridge: "b", rootfsGb: 8, servicesPath: join(dir, "services.json"), workspace: dir, healthGateMs: 90_000 };
}
const manifest = (id: string): ServiceManifest => ({ id, type: "service", name: id, start: "run", port: 3000 });

const passGate: HealthGate = { async waitHealthy() { return { ok: true, probes: 2 }; } };
const failGate: HealthGate = { async waitHealthy() { return { ok: false, reason: "health gate deadline (10ms) expired without two stable good probes", lastState: { active: "activating", nRestarts: 7, tier: "tcp", netOk: false } }; } };

function fakes(overrides: Partial<LxcClient> = {}) {
  const calls: string[] = [];
  const specs: Array<Record<string, unknown>> = [];
  const lxc: LxcClient = {
    async create(s) { calls.push(`create:${s.name}`); specs.push(s); return { id: 200 }; },
    async start(id) { calls.push(`start:${id}`); },
    async stop(id) { calls.push(`stop:${id}`); },
    async destroy(id) { calls.push(`destroy:${id}`); },
    async status(id) { return { id, status: "stopped" }; }, // so waitStopped exits immediately in tests
    async ip() { return "10.0.0.9"; },
    ...overrides,
  };
  const deployed: string[] = [];
  const deployedEnv: Array<Record<string, string> | undefined> = [];
  const deployer: ServiceDeployer = { async deploy(_t, dirArg, m, extraEnv, _deployId) { deployed.push(`${m.id}@${dirArg}`); deployedEnv.push(extraEnv); } };
  return { calls, specs, deployer, deployed, deployedEnv, lxc };
}

describe("createServiceOps.redeploy", () => {
  const seed = () => appendService(cfg().servicesPath, {
    id: "sales", name: "sales", containerId: 105, host: "10.0.0.5", port: 3000,
    basePath: "/services/sales", status: "healthy", createdAt: "T0", deployId: "OLD",
  });

  it("end-state success: gates new container, replaces registry entry, destroys old", async () => {
    seed();
    const { calls, deployer, lxc } = fakes();          // fake create returns id 200
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T1", readManifest: manifest, sleep: async () => {}, gate: passGate, newDeployId: () => "NEW" });
    const { entry, warning } = await ops.redeploy("sales");
    expect(warning).toBeUndefined();
    expect(entry).toMatchObject({ id: "sales", containerId: 200, deployId: "NEW", status: "healthy", updatedAt: "T1", createdAt: "T0" });
    const reg = loadServices(cfg().servicesPath);
    expect(reg).toHaveLength(1);
    expect(reg[0].containerId).toBe(200);
    expect(calls.filter((c) => c.startsWith("destroy:"))).toEqual(["destroy:105"]);   // old destroyed AFTER cutover
  });

  it("end-state (b): gate failure destroys the NEW container; old container and registry untouched", async () => {
    seed();
    const { calls, deployer, lxc } = fakes();
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T1", readManifest: manifest, sleep: async () => {}, gate: failGate });
    await expect(ops.redeploy("sales")).rejects.toThrow(/health gate/);
    expect(calls.filter((c) => c.startsWith("destroy:"))).toEqual(["destroy:200"]);
    expect(loadServices(cfg().servicesPath)[0]).toMatchObject({ containerId: 105, deployId: "OLD" });
  });

  it("end-state (c): old-container destroy failure surfaces a warning naming the container, cutover stands", async () => {
    seed();
    const { deployer, lxc } = fakes({ destroy: async (id: number) => { if (id === 105) throw new Error("PVE timeout"); } });
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T1", readManifest: manifest, sleep: async () => {}, gate: passGate, newDeployId: () => "NEW" });
    const { entry, warning } = await ops.redeploy("sales");
    expect(entry.containerId).toBe(200);
    expect(warning).toContain("105");
    expect(loadServices(cfg().servicesPath)[0].containerId).toBe(200);
  });

  it("end-state (a): not-deployed id errors before any container work", async () => {
    const { calls, deployer, lxc } = fakes();
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T1", readManifest: manifest, sleep: async () => {}, gate: passGate });
    await expect(ops.redeploy("ghost")).rejects.toThrow('service "ghost" is not deployed; use spawn_service');
    expect(calls).toEqual([]);
  });

  it("end-state (a): unknown data source errors before any container work", async () => {
    seed();
    const { calls, deployer, lxc } = fakes();
    const m = (id: string): ServiceManifest => ({ ...manifest(id), dataSources: ["nope"] });
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T1", readManifest: m, sleep: async () => {}, gate: passGate, resolveDataSource: () => undefined });
    await expect(ops.redeploy("sales")).rejects.toThrow("unknown data source: nope");
    expect(calls).toEqual([]);
  });

  it("tears down the NEW container when the registry write fails mid-flight (race with destroy_service)", async () => {
    seed();
    const { calls, lxc } = fakes();
    // Simulate another actor racing this redeploy: by the time deploy runs (before
    // the gate and the registry cutover), the "sales" entry has already been removed
    // from the registry — a faithful stand-in for a concurrent destroy_service.
    const deployer: ServiceDeployer = {
      async deploy() { removeService(cfg().servicesPath, "sales"); },
    };
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T1", readManifest: manifest, sleep: async () => {}, gate: passGate, newDeployId: () => "NEW" });
    await expect(ops.redeploy("sales")).rejects.toThrow(/is not registered/);
    expect(calls.filter((c) => c.startsWith("destroy:"))).toEqual(["destroy:200"]);
    const reg = loadServices(cfg().servicesPath);
    expect(reg.find((s) => s.id === "sales")).toBeUndefined();
  });
});
