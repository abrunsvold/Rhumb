import express, { type Express, type Request, type Response } from "express";
import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { readSurfaceMeta } from "./registry.js";
import { writeSseEvent } from "./sse.js";
import type { RegistrySnapshot } from "./types.js";

const ID_RE = /^[A-Za-z0-9._-]+$/;

export function createServer(deps: {
  getSnapshot: () => RegistrySnapshot;
  workspace: string;
  subscribers: Set<Response>;
}): Express {
  const app = express();
  const surfacesRoot = resolve(deps.workspace, "surfaces");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/registry", (_req, res) => {
    res.json(deps.getSnapshot());
  });

  app.get("/registry/stream", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    writeSseEvent(res, { type: "registry", ...deps.getSnapshot() });
    deps.subscribers.add(res);
    req.on("close", () => deps.subscribers.delete(res));
  });

  const serveSurface = (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!ID_RE.test(id)) {
      res.sendStatus(404);
      return;
    }
    const surfaceDir = resolve(surfacesRoot, id);
    // Splat sub-path (already URL-decoded by Express); default to the entry.
    let rel = (req.params[0] as string | undefined) ?? "";
    if (rel === "" || rel.endsWith("/")) {
      const meta = readSurfaceMeta(surfaceDir);
      if (!meta) {
        res.sendStatus(404);
        return;
      }
      rel = rel + meta.entry;
    }
    const target = resolve(surfaceDir, rel);
    // Lexical pre-filter: reject path strings that escape the surface dir.
    if (!(target === surfaceDir || target.startsWith(surfaceDir + sep))) {
      res.sendStatus(404);
      return;
    }
    // Filesystem confinement: resolve symlinks and re-check, so a symlink
    // inside the surface cannot point outside it. Any resolution failure → 404.
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = realpathSync(surfaceDir);
      realTarget = realpathSync(target);
    } catch {
      res.sendStatus(404);
      return;
    }
    if (!(realTarget === realRoot || realTarget.startsWith(realRoot + sep))) {
      res.sendStatus(404);
      return;
    }
    res.sendFile(realTarget, (err) => {
      if (err) res.sendStatus(404);
    });
  };

  app.get("/surfaces/:id", serveSurface);
  app.get("/surfaces/:id/*", serveSurface);

  return app;
}
