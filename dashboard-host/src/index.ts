import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import express, { type Express, type Response } from "express";
import { loadConfig, type Config } from "./config.js";
import { createServer } from "./server.js";
import { startWatcher, type WatchFn } from "./watcher.js";
import { writeSseEvent } from "./sse.js";
import type { RegistrySnapshot } from "./types.js";
import { loadServices, serviceToRegistryEntry } from "./services/registry.js";
import { createServiceProxy } from "./services/proxy.js";
import { loadDataSources } from "./data/sources.js";
import { createPgExecutor } from "./data/pgExecutor.js";
import { PendingQueue } from "./data/writes.js";
import { createDataRouter } from "./data/router.js";
import { resolveSurfaceToken } from "./surfaces/token.js";
import type { QueryExecutor, DataSource } from "./data/types.js";
import { startProbe, tcpProbe, makeStatusWriter } from "./services/probe.js";
import { requireShellHeader } from "./identity.js";
import { createControlTokenGuard } from "./auth.js";

export function buildApp(deps: {
  config: Config;
  watch: WatchFn;
  executorFor?: (source: DataSource) => QueryExecutor;
}): Express {
  const surfacesRoot = resolve(deps.config.workspace, "surfaces");
  const servicesPath = deps.config.servicesPath;
  const subscribers = new Set<Response>();
  let current: RegistrySnapshot = { surfaces: [] };

  const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

  const app = createServer({
    getSnapshot: () => ({
      surfaces: [...current.surfaces, ...loadServices(servicesPath).map(serviceToRegistryEntry)],
    }),
    workspace: deps.config.workspace,
    subscribers,
    appOrigins: deps.config.appOrigins,
    identity: { allowedUsers: deps.config.allowedUsers, insecureDev: deps.config.insecureDev },
    version,
  });

  // Bound request bodies: this host is unauthenticated on the tailnet, and data
  // ops are small. An explicit cap keeps a hostile caller from posting huge bodies.
  app.use(express.json({ limit: "64kb" }));

  startWatcher({
    root: surfacesRoot,
    watch: deps.watch,
    onSnapshot: (snap) => {
      current = snap;
      for (const r of subscribers) writeSseEvent(r, { type: "registry", ...snap });
    },
  });

  const executorFor = deps.executorFor ?? createPgExecutor;
  const executorCache = new Map<string, QueryExecutor>();
  const getExecutor = (sourceId: string): QueryExecutor => {
    let ex = executorCache.get(sourceId);
    if (!ex) {
      const src = loadDataSources(deps.config.dataSourcesPath).find((s) => s.id === sourceId);
      if (!src) throw new Error(`unknown source: ${sourceId}`);
      ex = executorFor(src);
      executorCache.set(sourceId, ex);
    }
    return ex;
  };

  const now = () => new Date().toISOString();
  const queue = new PendingQueue({ getExecutor, auditPath: deps.config.dataAuditPath, now, id: () => crypto.randomUUID() });

  app.use(
    "/data",
    createDataRouter({
      getSources: () => loadDataSources(deps.config.dataSourcesPath),
      getExecutor,
      queue,
      trustPath: deps.config.dataTrustPath,
      auditPath: deps.config.dataAuditPath,
      now,
      pendingGuard: deps.config.insecureDev
        ? createControlTokenGuard(deps.config.controlToken)
        : requireShellHeader(),
      resolveToken: (t) => resolveSurfaceToken(surfacesRoot, t),
    }),
  );

  app.use("/services", createServiceProxy({ getServices: () => loadServices(servicesPath) }));

  return app;
}

// Production watch source backed by chokidar.
const chokidarWatch: WatchFn = (dir, onChange) => {
  const w = chokidar.watch(dir, { ignoreInitial: true });
  w.on("all", () => onChange());
  return { close: () => void w.close() };
};

export function main(): void {
  const config = loadConfig(process.env);
  mkdirSync(resolve(config.workspace, "surfaces"), { recursive: true });
  const app = buildApp({ config, watch: chokidarWatch });
  const bindHost = config.insecureDev ? "0.0.0.0" : "127.0.0.1";
  app.listen(config.port, bindHost, () => {
    console.log(`rhumb dashboard-host listening on ${bindHost}:${config.port} (workspace ${config.workspace})`);
    if (config.insecureDev) {
      console.warn(
        "[rhumb] WARNING: RHUMB_INSECURE_DEV=1 — identity auth is OFF and the " +
          "host binds all interfaces. Never run this mode outside local development.",
      );
    } else {
      console.log(
        `[rhumb] identity mode: loopback-only, ${config.allowedUsers.length} allowed user(s); ` +
          "reachable via tailscale serve at /",
      );
    }
  });
  startProbe(
    { getServices: () => loadServices(config.servicesPath), probe: tcpProbe, writeStatus: makeStatusWriter(config.servicesPath) },
    15_000,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
