import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import type { Express, Response } from "express";
import { loadConfig, type Config } from "./config.js";
import { createServer } from "./server.js";
import { startWatcher, type WatchFn } from "./watcher.js";
import { writeSseEvent } from "./sse.js";
import type { RegistrySnapshot } from "./types.js";

export function buildApp(deps: { config: Config; watch: WatchFn }): Express {
  const surfacesRoot = resolve(deps.config.workspace, "surfaces");
  const subscribers = new Set<Response>();
  let current: RegistrySnapshot = { surfaces: [] };

  const app = createServer({
    getSnapshot: () => current,
    workspace: deps.config.workspace,
    subscribers,
  });

  startWatcher({
    root: surfacesRoot,
    watch: deps.watch,
    onSnapshot: (snap) => {
      current = snap;
      for (const r of subscribers) writeSseEvent(r, { type: "registry", ...snap });
    },
  });

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
