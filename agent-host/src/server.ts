import express, { type Express, type Request, type Response } from "express";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, parse as parsePath } from "node:path";
import type { AgentEvent } from "./types.js";
import { writeSseEvent } from "./sse.js";
import { createControlTokenGuard } from "./auth.js";

interface ManagerLike {
  run(
    prompt: string,
    sessionId: string | undefined,
    onEvent: (e: AgentEvent) => void,
  ): Promise<string>;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

function subsFor(map: Map<string, Set<Response>>, id: string): Set<Response> {
  let set = map.get(id);
  if (!set) {
    set = new Set();
    map.set(id, set);
  }
  return set;
}

export function pruneSubscriber(
  map: Map<string, Set<Response>>,
  id: string,
  res: Response,
): void {
  const set = map.get(id);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) map.delete(id);
}

export function createServer(deps: {
  manager: ManagerLike;
  turnSubscribers?: Map<string, Set<Response>>;
  controlToken?: string;
  workspace?: string;
}): Express {
  const app = express();
  app.use("/files", express.json({ limit: "30mb" }));
  app.use(express.json());

  // session id -> SSE responses ("" is the pending bucket for new sessions).
  const subscribers = new Map<string, Set<Response>>();
  // turn id -> SSE responses (stream-first: client subscribes before posting).
  const turnSubscribers = deps.turnSubscribers ?? new Map<string, Set<Response>>();

  // Liveness is unauthenticated; everything after this requires the control
  // token (when one is configured). Routes mounted later on this app by index.ts
  // (e.g. /infra) sit behind the guard too, since it is registered first.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(createControlTokenGuard(deps.controlToken));

  app.get("/sessions/:id/stream", (req: Request, res: Response) => {
    res.set(SSE_HEADERS);
    res.flushHeaders?.();
    const id = req.params.id;
    subsFor(subscribers, id).add(res);
    req.on("close", () => pruneSubscriber(subscribers, id, res));
  });

  app.get("/turns/:turnId/stream", (req: Request, res: Response) => {
    res.set(SSE_HEADERS);
    res.flushHeaders?.();
    const turnId = req.params.turnId;
    subsFor(turnSubscribers, turnId).add(res);
    req.on("close", () => pruneSubscriber(turnSubscribers, turnId, res));
  });

  app.post("/messages", (req: Request, res: Response) => {
    const { sessionId, prompt, turnId } = req.body ?? {};
    if (typeof prompt !== "string" || prompt.length === 0) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    const inputId: string | undefined =
      typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
    const turn: string | undefined =
      typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;

    let targetId = inputId ?? "";

    const onEvent = (e: AgentEvent) => {
      if (e.type === "session" && e.sessionId && e.sessionId !== targetId) {
        const pending = subscribers.get(targetId);
        if (pending) {
          const dest = subsFor(subscribers, e.sessionId);
          for (const r of pending) dest.add(r);
          if (targetId === "") subscribers.delete("");
        }
        targetId = e.sessionId;
      }
      for (const r of subscribers.get(targetId) ?? []) writeSseEvent(r, e);
      if (turn) {
        for (const r of turnSubscribers.get(turn) ?? []) writeSseEvent(r, e);
      }
    };

    void deps.manager.run(prompt, inputId, onEvent);

    res.status(202).json({ sessionId: inputId ?? "", turnId: turn ?? "" });
  });

  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

  if (deps.workspace) {
    const workspace = deps.workspace;
    app.post("/files", (req: Request, res: Response) => {
      const { name, contentBase64 } = req.body ?? {};
      if (typeof name !== "string" || typeof contentBase64 !== "string") {
        res.status(400).json({ error: "name and contentBase64 are required" });
        return;
      }
      // Basenames only: no separators, no traversal, no dotfiles.
      if (name.length === 0 || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
        res.status(400).json({ error: "invalid file name" });
        return;
      }
      const bytes = Buffer.from(contentBase64, "base64");
      if (bytes.length > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: "file exceeds 20MB limit" });
        return;
      }
      const dir = join(workspace, "uploads");
      mkdirSync(dir, { recursive: true });
      const { name: stem, ext } = parsePath(name);
      let stored = name;
      for (let n = 2; existsSync(join(dir, stored)); n++) {
        stored = `${stem}-${n}${ext}`;
      }
      writeFileSync(join(dir, stored), bytes);
      res.json({ path: `uploads/${stored}` });
    });
  }

  return app;
}
