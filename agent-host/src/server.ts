import express, { type Express, type Response } from "express";
import type { AgentEvent } from "./types.js";
import { writeSseEvent } from "./sse.js";

interface ManagerLike {
  run(
    prompt: string,
    sessionId: string | undefined,
    onEvent: (e: AgentEvent) => void,
  ): Promise<string>;
}

export function createServer(deps: { manager: ManagerLike }): Express {
  const app = express();
  app.use(express.json());

  // session id -> set of open SSE responses. "" is the pending bucket for
  // turns that started a brand-new session whose id is not known yet.
  const subscribers = new Map<string, Set<Response>>();
  const subsFor = (id: string) => {
    let set = subscribers.get(id);
    if (!set) {
      set = new Set();
      subscribers.set(id, set);
    }
    return set;
  };

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/sessions/:id/stream", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    const id = req.params.id;
    const set = subsFor(id);
    set.add(res);
    req.on("close", () => set.delete(res));
  });

  app.post("/messages", (req, res) => {
    const { sessionId, prompt } = req.body ?? {};
    if (typeof prompt !== "string" || prompt.length === 0) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    const inputId: string | undefined =
      typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;

    // Subscribers connect against the input id when known, else the pending "" bucket.
    let targetId = inputId ?? "";

    const onEvent = (e: AgentEvent) => {
      if (e.type === "session" && e.sessionId && e.sessionId !== targetId) {
        // Rekey pending subscribers to the freshly-minted session id.
        const pending = subscribers.get(targetId);
        if (pending) {
          const dest = subsFor(e.sessionId);
          for (const r of pending) dest.add(r);
          if (targetId === "") subscribers.delete("");
        }
        targetId = e.sessionId;
      }
      for (const r of subscribers.get(targetId) ?? []) writeSseEvent(r, e);
    };

    // Fire the turn in the background; clients read results via the SSE stream.
    void deps.manager.run(prompt, inputId, onEvent);

    res.status(202).json({ sessionId: inputId ?? "" });
  });

  return app;
}
