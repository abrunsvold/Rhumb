import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceOps } from "../src/services/ops.js";
import { loadServices, appendService, removeService, replaceService } from "../src/services/registry.js";
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

describe("registry", () => {
  const entry = (id: string, containerId = 1) => ({
    id, name: id, containerId, host: "h", port: 3000,
    basePath: `/services/${id}`, status: "healthy" as const, createdAt: "t",
  });

  it("append adds, throws on duplicate id, remove drops, corrupt→[]", () => {
    const p = join(dir, "s.json");
    expect(appendService(p, entry("a"))).toHaveLength(1);
    expect(() => appendService(p, entry("a"))).toThrow('service "a" already registered');
    expect(removeService(p, "a")).toHaveLength(0);
    expect(loadServices(join(dir, "missing.json"))).toEqual([]);
  });

  it("replace swaps the entry in place and preserves order", () => {
    const p = join(dir, "s.json");
    appendService(p, entry("a", 1));
    appendService(p, entry("b", 2));
    const swapped = { ...entry("a", 9), deployId: "20260704120000-abc123", updatedAt: "T2" };
    const out = replaceService(p, swapped);
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
    expect(out[0]).toMatchObject({ containerId: 9, deployId: "20260704120000-abc123", updatedAt: "T2" });
  });

  it("replace throws when the id is not registered", () => {
    const p = join(dir, "s.json");
    expect(() => replaceService(p, entry("ghost"))).toThrow('service "ghost" is not registered');
  });
});

describe("createServiceOps.spawn", () => {
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

  it("creates, awaits IP, deploys, and registers", async () => {
    const { calls, deployer, deployed, lxc } = fakes();
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T", readManifest: manifest, sleep: async () => {}, gate: passGate });
    const entry = await ops.spawn("sales");
    expect(entry).toMatchObject({ id: "sales", containerId: 200, host: "10.0.0.9", port: 3000, basePath: "/services/sales", status: "healthy" });
    expect(calls).toEqual(["create:rhumb-sales", "start:200"]);
    expect(deployed).toEqual([`sales@${join(dir, "services", "sales")}`]);
    expect(loadServices(cfg().servicesPath).map((s) => s.id)).toEqual(["sales"]);
  });

  it("rolls back (destroys the container) if deploy fails", async () => {
    const { calls, lxc } = fakes();
    const badDeployer: ServiceDeployer = { async deploy(_t, _dir, _m, _env, _id) { throw new Error("scp failed"); } };
    const ops = createServiceOps({ lxc, deployer: badDeployer, config: cfg(), now: () => "T", readManifest: manifest, sleep: async () => {}, gate: passGate });
    await expect(ops.spawn("sales")).rejects.toThrow(/scp failed/);
    // rollback stops the (running) container before destroying it
    expect(calls).toEqual(["create:rhumb-sales", "start:200", "stop:200", "destroy:200"]);
    expect(loadServices(cfg().servicesPath)).toEqual([]);
  });

  it("destroy stops+destroys the container and deregisters", async () => {
    const { calls, deployer, lxc } = fakes();
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T", readManifest: manifest, sleep: async () => {}, gate: passGate });
    await ops.spawn("sales");
    await ops.destroy("sales");
    expect(calls).toEqual(["create:rhumb-sales", "start:200", "stop:200", "destroy:200"]);
    expect(loadServices(cfg().servicesPath)).toEqual([]);
  });

  it("rejects a traversal id before reading a manifest or creating a container", async () => {
    const { calls, deployer, lxc } = fakes();
    let readCalled = false;
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T", readManifest: (id) => { readCalled = true; return manifest(id); }, sleep: async () => {}, gate: passGate });
    await expect(ops.spawn("../../etc")).rejects.toThrow(/invalid service id/);
    expect(readCalled).toBe(false);
    expect(calls).toEqual([]);
  });

  it("rejects a manifest whose id does not match the requested id (no container created)", async () => {
    const { calls, deployer, lxc } = fakes();
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T", readManifest: () => manifest("other"), sleep: async () => {}, gate: passGate });
    await expect(ops.spawn("sales")).rejects.toThrow(/does not match/);
    expect(calls).toEqual([]);
  });

  it("injects a resolved data-source connection as extraEnv (DATABASE_URL for a single source)", async () => {
    const { deployedEnv, deployer, lxc } = fakes();
    const withSource = (id: string): ServiceManifest => ({ ...manifest(id), dataSources: ["printers"] });
    const ops = createServiceOps({
      lxc, deployer, config: cfg(), now: () => "T", readManifest: withSource, sleep: async () => {},
      resolveDataSource: (id) => (id === "printers" ? "postgres://u:p@h:5432/printers" : undefined),
      gate: passGate,
    });
    await ops.spawn("poller");
    expect(deployedEnv[0]).toEqual({
      DATABASE_URL: "postgres://u:p@h:5432/printers",
      RHUMB_DATASOURCE_PRINTERS: "postgres://u:p@h:5432/printers",
    });
  });

  it("throws for an unknown data source before creating a container", async () => {
    const { calls, deployer, lxc } = fakes();
    const withSource = (id: string): ServiceManifest => ({ ...manifest(id), dataSources: ["ghost"] });
    const ops = createServiceOps({
      lxc, deployer, config: cfg(), now: () => "T", readManifest: withSource, sleep: async () => {},
      resolveDataSource: () => undefined,
      gate: passGate,
    });
    await expect(ops.spawn("poller")).rejects.toThrow(/ghost|unknown data source/);
    expect(calls).toEqual([]);
  });

  it("passes config.nameserver through to the container spec (fresh containers otherwise inherit an unusable resolver)", async () => {
    const { specs, deployer, lxc } = fakes();
    const ops = createServiceOps({ lxc, deployer, config: { ...cfg(), nameserver: "1.1.1.1" }, now: () => "T", readManifest: manifest, sleep: async () => {}, gate: passGate });
    await ops.spawn("sales");
    expect(specs[0]).toMatchObject({ nameserver: "1.1.1.1" });
  });

  it("spawn registers with a deployId and gate-passed health", async () => {
    const { deployer, lxc } = fakes();
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T", readManifest: manifest, sleep: async () => {}, gate: passGate, newDeployId: () => "20260704200000-abc123" });
    const entry = await ops.spawn("sales");
    expect(entry.deployId).toBe("20260704200000-abc123");
    expect(entry.status).toBe("healthy");
  });

  it("spawn rolls back the new container when the health gate fails", async () => {
    const { calls, deployer, lxc } = fakes();
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T", readManifest: manifest, sleep: async () => {}, gate: failGate });
    await expect(ops.spawn("sales")).rejects.toThrow(/health gate deadline/);
    expect(calls).toContain("destroy:200");
    expect(loadServices(cfg().servicesPath)).toEqual([]);            // end-state (b): registry untouched
  });

  it("spawn on an already-registered id errors and touches nothing", async () => {
    const { calls, deployer, lxc } = fakes();
    appendService(cfg().servicesPath, { id: "sales", name: "sales", containerId: 105, host: "h", port: 3000, basePath: "/services/sales", status: "healthy", createdAt: "T" });
    const ops = createServiceOps({ lxc, deployer, config: cfg(), now: () => "T", readManifest: manifest, sleep: async () => {}, gate: passGate });
    await expect(ops.spawn("sales")).rejects.toThrow('service "sales" is already deployed (container 105); use redeploy_service to update it');
    expect(calls).toEqual([]);                                        // end-state (a): no container created
  });
});
