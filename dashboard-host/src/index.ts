import { mkdirSync } from "node:fs";
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
import { loadDataSources } from "./data/sources.js";
import { createPgExecutor } from "./data/pgExecutor.js";
import { PendingQueue } from "./data/writes.js";
import { createDataRouter } from "./data/router.js";
import type { QueryExecutor, DataSource } from "./data/types.js";

export function buildApp(deps: {
  config: Config;
  watch: WatchFn;
  executorFor?: (source: DataSource) => QueryExecutor;
}): Express {
  const surfacesRoot = resolve(deps.config.workspace, "surfaces");
  const servicesPath = deps.config.servicesPath;
  const subscribers = new Set<Response>();
  let current: RegistrySnapshot = { surfaces: [] };

  const app = createServer({
    getSnapshot: () => ({
      surfaces: [...current.surfaces, ...loadServices(servicesPath).map(serviceToRegistryEntry)],
    }),
    workspace: deps.config.workspace,
    subscribers,
  });

  app.use(express.json());

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
    }),
  );

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
  app.listen(config.port, () => {
    console.log(`rhumbr dashboard-host listening on :${config.port} (workspace ${config.workspace})`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
