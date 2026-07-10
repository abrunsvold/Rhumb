import express, { type Router } from "express";
import type { OntologyOps } from "./ops.js";

export function createOntologyRouter(deps: { ops: OntologyOps }): Router {
  const router = express.Router();

  router.get("/", (_req, res) => {
    // Sync-on-read: a reader must never see a projection older than its own
    // request (dogfood F16). A failing projector degrades to the last-good
    // nodes on disk with the error visible in status — never a 500.
    try { deps.ops.sync(); } catch { /* outcome recorded by ops.status() */ }
    const { syncedAt, syncError } = deps.ops.status();
    res.json({ nodes: deps.ops.list(), syncedAt, syncError });
  });

  return router;
}
