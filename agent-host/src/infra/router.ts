import express, { type Router, type Request, type Response } from "express";
import type { PendingActions } from "./pending.js";
import type { PendingAction } from "./types.js";

export function createInfraRouter(deps: {
  pending: PendingActions;
  executeParked?: (a: PendingAction) => Promise<void>;
  // Blocking entries audit their resolution inside the gate (the awaiting
  // canUseTool); parked entries have no waiter, so the router records the
  // operator's decision here — a denied proposal must leave a trace too.
  auditResolution?: (a: PendingAction, decision: "approved" | "denied", actor: string) => void;
  // Derives the acting login from the request. Omitted in tests that do not
  // care about attribution; index.ts supplies the identity-header reader.
  actorOf?: (req: Request) => string;
}): Router {
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
    const entry = deps.pending.get(req.params.id);
    const actor = deps.actorOf?.(req) ?? "";
    const ok = deps.pending.resolve(req.params.id, decision, actor);
    if (!ok) {
      if (!entry) return void res.sendStatus(404);
      // Everyone in the room sees the same dialog, so two people can hit
      // approve at once. First decision wins; the loser is told who won
      // rather than being handed a confusing 404.
      const settled = deps.pending.get(req.params.id);
      return void res.status(409).json({
        error: "already resolved",
        by: settled?.resolvedBy ?? "",
        decision: settled?.status ?? "",
      });
    }
    // A blocking entry's turn continues on its own promise. An approved
    // parked entry executes in the background — respond now, outcome lands
    // on the entry (executed/failed stream events) and in the audit.
    if (entry?.mode === "parked") {
      deps.auditResolution?.(entry, decision === "approve" ? "approved" : "denied", actor);
      if (decision === "approve") {
        void deps.executeParked?.(deps.pending.get(req.params.id) as PendingAction);
      }
    }
    res.json({ ok: true });
  });

  return router;
}
