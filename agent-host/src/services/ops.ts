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
  waitForIpMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): ServiceOps {
  const { lxc, deployer, config, now } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const waitForIpMs = deps.waitForIpMs ?? 60_000;

  function entryFor(id: string): ServiceEntry | undefined {
    return loadServices(config.servicesPath).find((s) => s.id === id);
  }

  return {
    async spawn(id: string): Promise<ServiceEntry> {
      assertServiceId(id);                       // reject traversal before any fs/path use
      const manifest = deps.readManifest(id);
      if (manifest.id !== id) throw new Error(`manifest id "${manifest.id}" does not match requested id "${id}"`);
      const spec = {
        name: `rhumbr-${manifest.id}`,
        cores: manifest.resources?.cores ?? 1,
        memory: manifest.resources?.memory ?? 512,
        ostemplate: config.ostemplate,
        storage: config.storage,
        bridge: config.bridge,
        rootfsGb: config.rootfsGb,
        sshPublicKey: config.deployPublicKey,
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
        );
        const entry: ServiceEntry = {
          id: manifest.id, name: manifest.name, containerId, host, port: manifest.port,
          basePath: `/services/${manifest.id}`, status: "healthy", createdAt: now(),
        };
        appendService(config.servicesPath, entry);
        return entry;
      } catch (e) {
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
      await lxc.destroy(e.containerId);
      removeService(config.servicesPath, id);
    },
    list(): ServiceEntry[] { return loadServices(config.servicesPath); },
    status(id: string): ServiceEntry | undefined { return entryFor(id); },
  };
}
