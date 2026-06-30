import express, { type Express, type Request, type Response } from "express";
import { resolve, sep } from "node:path";
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
    // Decode and normalize the sub-path; default to the surface's entry.
    let rel = "";
    try {
      rel = decodeURIComponent((req.params[0] as string | undefined) ?? "");
    } catch {
      res.sendStatus(404);
      return;
    }
    if (rel === "" || rel.endsWith("/")) {
      const meta = readSurfaceMeta(surfaceDir);
      if (!meta) {
        res.sendStatus(404);
        return;
      }
      rel = rel + meta.entry;
    }
    const target = resolve(surfaceDir, rel);
    const within = target === surfaceDir || target.startsWith(surfaceDir + sep);
    if (!within) {
      res.sendStatus(404);
      return;
    }
    res.sendFile(target, (err) => {
      if (err) res.sendStatus(404);
    });
  };

  app.get("/surfaces/:id", serveSurface);
  app.get("/surfaces/:id/*", serveSurface);

  return app;
}
