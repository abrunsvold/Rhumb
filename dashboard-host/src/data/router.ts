import express, { type Router, type Request, type Response, type RequestHandler } from "express";
import { findSource } from "./sources.js";
import { buildSql } from "./sql.js";
import { executeWrite, type PendingQueue } from "./writes.js";
import { loadTrust, isTrusted, addTrust } from "./trust.js";
import type { DataSource, DataOp, QueryExecutor } from "./types.js";

export interface DataRouterDeps {
  getSources: () => DataSource[];
  getExecutor: (sourceId: string) => QueryExecutor;
  queue: PendingQueue;
  trustPath: string;
  auditPath: string;
  now: () => string;
  pendingGuard: RequestHandler;
  resolveToken: (token: string) => string | null;
}

export function createDataRouter(deps: DataRouterDeps): Router {
  const router = express.Router();

  const surfaceIdFromToken = (req: Request): string | null =>
    deps.resolveToken(req.get("x-rhumb-surface-token") ?? "");

  router.post("/:source/query", async (req: Request, res: Response) => {
    if (surfaceIdFromToken(req) === null) return void res.status(401).json({ error: "unauthorized" });
    const source = findSource(deps.getSources(), req.params.source);
    if (!source) return void res.sendStatus(404);
    const op = req.body?.op as DataOp | undefined;
    if (!op || op.kind !== "select") return void res.status(400).json({ error: "query requires a select op" });
    try {
      const result = await deps.getExecutor(source.id).run(buildSql(op));
      res.json({ rows: result.rows });
    } catch (err) {
      // Never echo the raw DB error (it can disclose schema/table/role names) to
      // the caller; log the detail server-side and return a generic message.
      console.error(`[data] query failed for source ${source.id}:`, err);
      res.status(500).json({ error: "query failed" });
    }
  });

  router.post("/:source/write", async (req: Request, res: Response) => {
    const source = findSource(deps.getSources(), req.params.source);
    if (!source) return void res.sendStatus(404);
    if (source.mode !== "read-write") return void res.status(403).json({ error: "source is read-only" });
    const op = req.body?.op as DataOp | undefined;
    if (!op || op.kind === "select") return void res.status(400).json({ error: "write requires a mutating op" });
    const surfaceId = surfaceIdFromToken(req);

    // Trust lets a surface add and edit rows freely; a deletion always re-gates
    // for a human, so a trusted DELETE falls through to the pending queue.
    if (op.kind !== "delete" && isTrusted(loadTrust(deps.trustPath), source.id, surfaceId)) {
      try {
        const result = await executeWrite(
          { getExecutor: deps.getExecutor, auditPath: deps.auditPath, now: deps.now, id: () => "" },
          source.id, op, surfaceId, "trust",
        );
        return void res.json({ status: "executed", result });
      } catch (err) {
        console.error(`[data] write failed for source ${source.id}:`, err);
        return void res.status(500).json({ error: "write failed" });
      }
    }
    const w = deps.queue.enqueue(source.id, op, surfaceId);
    res.status(202).json({ pendingId: w.pendingId, status: "pending" });
  });

  // The pending-write approval control plane is shell-only: surfaces submit
  // writes (which get queued) but must never read the queue or resolve it.
  // In identity mode the guard is the Sec-Rhumb-Control shell header, which
  // browser JS cannot set; in dev mode it is the optional control token.
  router.use("/pending", deps.pendingGuard);

  router.get("/pending", (_req, res) => {
    res.json({ pending: deps.queue.list() });
  });

  router.get("/pending/stream", (req: Request, res: Response) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders?.();
    for (const w of deps.queue.list()) res.write(`data: ${JSON.stringify({ type: "added", write: w })}\n\n`);
    const unsub = deps.queue.subscribe((kind, w) => res.write(`data: ${JSON.stringify({ type: kind, write: w })}\n\n`));
    req.on("close", unsub);
  });

  router.get("/pending/:id", (req: Request, res: Response) => {
    const status = deps.queue.get(req.params.id);
    if (!status) return void res.sendStatus(404);
    res.json(status);
  });

  router.post("/pending/:id/resolve", async (req: Request, res: Response) => {
    const { decision, trustSurface } = req.body ?? {};
    if (decision !== "approve" && decision !== "deny") return void res.status(400).json({ error: "bad decision" });
    const pending = deps.queue.list().find((w) => w.pendingId === req.params.id);
    try {
      await deps.queue.resolve(req.params.id, decision);
    } catch (err) {
      console.error(`[data] resolve failed for ${req.params.id}:`, err);
      return void res.status(500).json({ error: "resolve failed" });
    }
    if (decision === "approve" && trustSurface && pending?.surfaceId) {
      addTrust(deps.trustPath, { source: pending.source, surfaceId: pending.surfaceId });
    }
    res.json({ ok: true });
  });

  return router;
}
