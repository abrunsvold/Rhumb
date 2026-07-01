import express, { type Router, type Request, type Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { ServiceEntry } from "./registry.js";

export function createServiceProxy(deps: { getServices: () => ServiceEntry[] }): Router {
  const router = express.Router();

  router.use("/:id", (req: Request, res: Response, next) => {
    const svc = deps.getServices().find((s) => s.id === req.params.id);
    if (!svc) return void res.sendStatus(404);
    const proxy = createProxyMiddleware({
      target: `http://${svc.host}:${svc.port}`,
      changeOrigin: true,
      ws: true,
      // strip the /services/:id mount prefix so the app sees the remainder at its root
      pathRewrite: (path) => path.replace(new RegExp(`^/services/${svc.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "") || "/",
      on: {
        error: (_err, _req, resu) => {
          const r = resu as Response;
          if (!r.headersSent) r.writeHead(502, { "Content-Type": "text/plain" });
          r.end("service upstream unreachable");
        },
      },
    });
    return proxy(req, res, next);
  });

  return router;
}
