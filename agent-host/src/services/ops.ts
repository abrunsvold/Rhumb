import { join } from "node:path";
import type { LxcClient, ServiceDeployer, ServiceConfig, ServiceManifest, ServiceEntry } from "./types.js";
import { loadServices, appendService, removeService } from "./registry.js";
import { assertServiceId } from "./manifest.js";

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ServiceOps {
  spawn(id: string): Promise<ServiceEntry>;
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

  return {
    async spawn(id: string): Promise<ServiceEntry> {
      assertServiceId(id);                       // reject traversal before any fs/path use
      const manifest = deps.readManifest(id);
      if (manifest.id !== id) throw new Error(`manifest id "${manifest.id}" does not match requested id "${id}"`);
      const extraEnv = buildExtraEnv(manifest);   // resolve data sources before provisioning (fail fast)
      const spec = {
        name: `rhumb-${manifest.id}`,
        cores: manifest.resources?.cores ?? 1,
        memory: manifest.resources?.memory ?? 512,
        ostemplate: config.ostemplate,
        storage: config.storage,
        bridge: config.bridge,
        rootfsGb: config.rootfsGb,
        sshPublicKey: config.deployPublicKey,
        nameserver: config.nameserver,
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
          manifest,
          extraEnv,
        );
        const entry: ServiceEntry = {
          id: manifest.id, name: manifest.name, containerId, host, port: manifest.port,
          basePath: `/services/${manifest.id}`, status: "healthy", createdAt: now(),
        };
        appendService(config.servicesPath, entry);
        return entry;
      } catch (e) {
        // Best-effort rollback: a running container can't be DELETEd on PVE, so
        // stop it first, then destroy. Both are swallowed — the original error wins.
        try { await lxc.stop(containerId); await waitStopped(containerId); } catch { /* may not be running */ }
        try { await lxc.destroy(containerId); } catch { /* best-effort rollback */ }
        throw e;
      }
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
