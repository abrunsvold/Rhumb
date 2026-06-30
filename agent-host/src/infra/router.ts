import express, { type Router, type Request, type Response } from "express";
import type { PendingActions } from "./pending.js";

export function createInfraRouter(deps: { pending: PendingActions }): Router {
  const router = express.Router();

  router.get("/pending", (_req, res) => {
    res.json({ pending: deps.pending.list() });
  });

  router.get("/pending/stream", (req: Request, res: Response) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders?.();
    for (const a of deps.pending.list()) res.write(`data: ${JSON.stringify({ type: "added", action: a })}\n\n`);
    const unsub = deps.pending.subscribe((kind, action) => res.write(`data: ${JSON.stringify({ type: kind, action })}\n\n`));
    req.on("close", unsub);
  });

  router.post("/pending/:id/resolve", (req: Request, res: Response) => {
    const { decision } = req.body ?? {};
    if (decision !== "approve" && decision !== "deny") return void res.status(400).json({ error: "bad decision" });
    const ok = deps.pending.resolve(req.params.id, decision);
    if (!ok) return void res.sendStatus(404);
    res.json({ ok: true });
  });

  return router;
}
