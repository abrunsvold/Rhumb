import express, { type Express, type Request, type Response } from "express";
import type { AgentEvent } from "./types.js";
import { writeSseEvent } from "./sse.js";

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

export function createServer(deps: {
  manager: ManagerLike;
  turnSubscribers?: Map<string, Set<Response>>;
}): Express {
  const app = express();
  app.use(express.json());

  // session id -> SSE responses ("" is the pending bucket for new sessions).
  const subscribers = new Map<string, Set<Response>>();
  // turn id -> SSE responses (stream-first: client subscribes before posting).
  const turnSubscribers = deps.turnSubscribers ?? new Map<string, Set<Response>>();

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/sessions/:id/stream", (req: Request, res: Response) => {
    res.set(SSE_HEADERS);
    res.flushHeaders?.();
    const set = subsFor(subscribers, req.params.id);
    set.add(res);
    req.on("close", () => set.delete(res));
  });

  app.get("/turns/:turnId/stream", (req: Request, res: Response) => {
    res.set(SSE_HEADERS);
    res.flushHeaders?.();
    const set = subsFor(turnSubscribers, req.params.turnId);
    set.add(res);
    req.on("close", () => set.delete(res));
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

  return app;
}
