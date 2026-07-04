import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { LxcClient, ServiceDeployer, ServiceConfig, ServiceManifest, ServiceEntry } from "./types.js";
import type { HealthGate } from "./health.js";
import { loadServices, appendService, removeService, replaceService } from "./registry.js";
import { assertServiceId } from "./manifest.js";

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const defaultDeployId = () =>
  `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;

export interface RedeployResult { entry: ServiceEntry; warning?: string }

export interface ServiceOps {
  spawn(id: string): Promise<ServiceEntry>;
  redeploy(id: string): Promise<RedeployResult>;
  stop(id: string): Promise<void>;
  start(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  list(): ServiceEntry[];
  status(id: string): ServiceEntry | undefined;
}

export function createServiceOps(deps: {
  lxc: LxcClient;
  deployer: ServiceDeployer;
  config: ServiceConfig;
  now: () => string;
  readManifest: (id: string) => ServiceManifest;
  resolveDataSource?: (id: string) => string | undefined;
  waitForIpMs?: number;
  sleep?: (ms: number) => Promise<void>;
  gate: HealthGate;
  newDeployId?: () => string;
}): ServiceOps {
  const { lxc, deployer, config, now } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const waitForIpMs = deps.waitForIpMs ?? 60_000;

  // Resolve each declared data source to a connection string and expose it to the
  // service as env: RHUMB_DATASOURCE_<ID> per source, plus DATABASE_URL for the
  // single-source common case. Throws on an unknown source so we fail before
  // provisioning a container that could never work.
  function buildExtraEnv(manifest: ServiceManifest): Record<string, string> {
    const ids = manifest.dataSources ?? [];
    const env: Record<string, string> = {};
    for (const sourceId of ids) {
      const conn = deps.resolveDataSource?.(sourceId);
      if (!conn) throw new Error(`unknown data source: ${sourceId}`);
      env[`RHUMB_DATASOURCE_${sourceId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = conn;
    }
    if (ids.length === 1) env.DATABASE_URL = env[`RHUMB_DATASOURCE_${ids[0].toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
    return env;
  }

  function entryFor(id: string): ServiceEntry | undefined {
    return loadServices(config.servicesPath).find((s) => s.id === id);
  }

  // Proxmox stop returns a task and completes asynchronously; PVE refuses to
  // DELETE a still-running container. Poll status until it is actually stopped
  // (bounded) before destroying.
  async function waitStopped(containerId: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      let st: { status: string };
      try {
        st = await lxc.status(containerId);
      } catch {
        return; // container likely already gone
      }
      if (st.status === "stopped") return;
      await sleep(1500);
    }
  }

  // Provision a fresh container and get the service healthy in it, or destroy the
  // container and throw. Shared by spawn and redeploy; never touches the registry.
  async function provisionHealthy(manifest: ServiceManifest, extraEnv: Record<string, string>, deployId: string): Promise<{ containerId: number; host: string }> {
    const spec = {
      name: `rhumb-${manifest.id}`,
      cores: manifest.resources?.cores ?? 1,
      memory: manifest.resources?.memory ?? 512,
      ostemplate: config.ostemplate, storage: config.storage, bridge: config.bridge,
      rootfsGb: config.rootfsGb, sshPublicKey: config.deployPublicKey, nameserver: config.nameserver,
    };
    const { id: containerId } = await lxc.create(spec);
    try {
      await lxc.start(containerId);
      let host: string | null = null;
      const deadline = Date.now() + waitForIpMs;
      while (host === null && Date.now() < deadline) {
        host = await lxc.ip(containerId);
        if (host === null) await sleep(2000);
      }
      if (host === null) throw new Error(`container ${containerId} never reported an IP`);
      await deployer.deploy(
        { host, user: "root", privateKeyPath: config.deployKeyPath },
        join(config.workspace, "services", manifest.id),
        manifest, extraEnv, deployId,
      );
      const gate = await deps.gate.waitHealthy({
        ssh: { host, user: "root", privateKeyPath: config.deployKeyPath },
        unit: `rhumb-${manifest.id}.service`,
        host, port: manifest.port, healthPath: manifest.healthPath,
      });
      if (!gate.ok) throw new Error(`service "${manifest.id}" failed its health gate: ${gate.reason} (last state: ${JSON.stringify(gate.lastState)})`);
      return { containerId, host };
    } catch (e) {
      await teardown(containerId);
      throw e;
    }
  }

  // Best-effort rollback: a running container can't be DELETEd on PVE, so stop it
  // first, then destroy. Both are swallowed — callers rethrow their own original
  // error, which always wins over any teardown failure.
  async function teardown(containerId: number): Promise<void> {
    try { await lxc.stop(containerId); await waitStopped(containerId); } catch { /* may not be running */ }
    try { await lxc.destroy(containerId); } catch { /* best-effort rollback */ }
  }

  return {
    async spawn(id: string): Promise<ServiceEntry> {
      assertServiceId(id);                       // reject traversal before any fs/path use
      const existing = entryFor(id);
      if (existing) throw new Error(`service "${id}" is already deployed (container ${existing.containerId}); use redeploy_service to update it`);
      const manifest = deps.readManifest(id);
      if (manifest.id !== id) throw new Error(`manifest id "${manifest.id}" does not match requested id "${id}"`);
      const extraEnv = buildExtraEnv(manifest);   // resolve data sources before provisioning (fail fast)
      const deployId = (deps.newDeployId ?? defaultDeployId)();
      const { containerId, host } = await provisionHealthy(manifest, extraEnv, deployId);
      const entry: ServiceEntry = {
        id: manifest.id, name: manifest.name, containerId, host, port: manifest.port,
        basePath: `/services/${manifest.id}`, status: "healthy", createdAt: now(), deployId,
      };
      try {
        appendService(config.servicesPath, entry);
      } catch (e) {
        // The container is up and healthy but we couldn't register it (e.g. a
        // concurrent actor registered the same id first) — tear it down rather
        // than leaving a running, unregistered container behind.
        await teardown(containerId);
        throw e;
      }
      return entry;
    },
    // Blue-green replace. End-states (see spec): (a) nothing changed on validation
    // errors; (b) gate/deploy failure destroys the new container, old untouched;
    // (c) cutover complete — an old-container destroy failure is a WARNING naming
    // the orphan, never silent, never a rollback (the registry already moved).
    //
    // Concurrency: intentionally no lock here. This is a single-operator tool and
    // every mutation already passes a separate operator approval, so a genuine
    // concurrent redeploy of the same service is an operator error, not something
    // we need to defend against with a mutex. Worst case, post-teardown-on-failure
    // above: two racing redeploys provision two containers, one registry write
    // wins (last-write-wins) and the other throws, and the losing side tears its
    // own new container down — at most a wasted container plus, if the loser also
    // raced the old container's destroy, a spurious old-destroy warning. No path
    // leaves a running container silently unregistered.
    async redeploy(id: string): Promise<RedeployResult> {
      assertServiceId(id);
      const old = entryFor(id);
      if (!old) throw new Error(`service "${id}" is not deployed; use spawn_service`);
      const manifest = deps.readManifest(id);
      if (manifest.id !== id) throw new Error(`manifest id "${manifest.id}" does not match requested id "${id}"`);
      const extraEnv = buildExtraEnv(manifest);
      const deployId = (deps.newDeployId ?? defaultDeployId)();
      const { containerId, host } = await provisionHealthy(manifest, extraEnv, deployId);
      const entry: ServiceEntry = {
        ...old, name: manifest.name, containerId, host, port: manifest.port,
        status: "healthy", deployId, updatedAt: now(),
      };
      try {
        replaceService(config.servicesPath, entry);
      } catch (e) {
        // The new container is up and healthy but the cutover write failed (e.g. a
        // concurrent destroy_service removed the entry out from under us) — tear
        // down the new container rather than leaving it running and unregistered.
        // The old container is untouched.
        await teardown(containerId);
        throw e;
      }
      let warning: string | undefined;
      try {
        try { await lxc.stop(old.containerId); } catch { /* may already be stopped */ }
        await waitStopped(old.containerId);
        await lxc.destroy(old.containerId);
      } catch (e) {
        warning = `cutover complete, but destroying the OLD container ${old.containerId} failed: ${String(e)} — clean it up manually (pct stop/destroy ${old.containerId})`;
      }
      return { entry, warning };
    },
    async stop(id: string): Promise<void> {
      const e = entryFor(id);
      if (!e) throw new Error(`unknown service: ${id}`);
      await lxc.stop(e.containerId);
    },
    async start(id: string): Promise<void> {
      const e = entryFor(id);
      if (!e) throw new Error(`unknown service: ${id}`);
      await lxc.start(e.containerId);
    },
    async destroy(id: string): Promise<void> {
      const e = entryFor(id);
      if (!e) throw new Error(`unknown service: ${id}`);
      try { await lxc.stop(e.containerId); } catch { /* may already be stopped */ }
      await waitStopped(e.containerId);
      await lxc.destroy(e.containerId);
      removeService(config.servicesPath, id);
    },
    list(): ServiceEntry[] { return loadServices(config.servicesPath); },
    status(id: string): ServiceEntry | undefined { return entryFor(id); },
  };
}
