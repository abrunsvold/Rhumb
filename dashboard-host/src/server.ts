import express, { type Express, type Request, type Response } from "express";
import { resolve, sep, basename } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { readSurfaceMeta } from "./registry.js";
import { writeSseEvent } from "./sse.js";
import type { RegistrySnapshot } from "./types.js";
import { getOrCreateSurfaceToken } from "./surfaces/token.js";
import { renderShim, injectShim } from "./surfaces/shim.js";
import { surfaceHeaders } from "./surfaces/headers.js";
import { createIdentityGuard } from "./identity.js";

const ID_RE = /^[A-Za-z0-9._-]+$/;

export function createServer(deps: {
  getSnapshot: () => RegistrySnapshot;
  workspace: string;
  subscribers: Set<Response>;
  appOrigins?: string[];
  identity: { allowedUsers: string[]; insecureDev: boolean };
  version: string;
}): Express {
  const app = express();
  const surfacesRoot = resolve(deps.workspace, "surfaces");
  const headers = surfaceHeaders(deps.appOrigins ?? []);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Discovery beacon: presence + path layout only, no secrets. Open like
  // /healthz so the client can probe tailnet peers before authenticating.
  app.get("/.well-known/rhumb.json", (_req, res) => {
    res.json({ rhumb: true, version: deps.version, paths: { agent: "/agent", dashboard: "/" } });
  });

  // Identity mode gates EVERYTHING below — registry, surfaces, data, services.
  // This closes the documented scrape-a-surface-token gap: fetching a surface
  // at all now requires an allowlisted tailnet identity. Dev mode keeps the
  // routes open exactly as before.
  if (!deps.identity.insecureDev) {
    app.use(createIdentityGuard(deps.identity.allowedUsers));
  }

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
    // Never serve dotfiles. This is defense-in-depth for the `.surface-token`
    // sidecar: the HTML branch below reads files directly (not via sendFile's
    // dotfiles:'ignore' default), so make the protection explicit here.
    if (basename(realTarget).startsWith(".")) {
      res.sendStatus(404);
      return;
    }
    res.set(headers);
    if (/\.html?$/i.test(realTarget)) {
      let html: string;
      try { html = readFileSync(realTarget, "utf8"); } catch { res.sendStatus(404); return; }
      const token = getOrCreateSurfaceToken(surfaceDir);
      res.type("html").send(injectShim(html, renderShim(id, token)));
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
