import express, { type Express, type Request, type Response } from "express";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, parse as parsePath } from "node:path";
import type { AgentEvent } from "./types.js";
import { writeSseEvent, attachHeartbeat } from "./sse.js";
import { createControlTokenGuard } from "./auth.js";
import { createIdentityGuard, requireShellHeader, readActorLogin } from "./identity.js";
import { stampAuthor } from "./envelope.js";
import type { SessionService } from "./sessions.js";
import { createTurnQueue, type TurnQueue } from "./queue.js";
import { buildRoster } from "./roster.js";

export interface IdentityDeps {
  allowedUsers: string[];
  insecureDev: boolean;
  controlToken?: string;
}

interface ManagerLike {
  run(
    prompt: string,
    sessionId: string | undefined,
    onEvent: (e: AgentEvent) => void,
  ): Promise<string>;
}

// Strip the tailscale-serve mount prefix from a request URL. Handles the bare
// mount ("/agent"), sub-paths ("/agent/messages"), and a query with no path
// ("/agent?x=1" → "/?x=1"); leaves sibling paths like "/agentx" untouched.
export function stripAgentPrefix(url: string): string {
  if (url !== "/agent" && !url.startsWith("/agent/") && !url.startsWith("/agent?")) return url;
  const rest = url.slice("/agent".length);
  if (rest === "") return "/";
  return rest.startsWith("?") ? `/${rest}` : rest;
}

// A client may name its own lane ONLY inside the draft namespace. Without this
// guard a caller could send a roomKey equal to another room's live session id,
// land its turn on that lane, and be handed that session to resume by
// `laneSession` — the same cross-room failure roomKey exists to prevent, done
// on purpose instead of by accident.
const DRAFT_ROOM_KEY_RE = /^draft:[0-9a-f-]{36}$/;

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

// Two connections from one person (a reconnect, or a second window) are one
// presence entry. Responses with no recorded login are subscribers that
// predate the login being tracked, and are skipped rather than shown blank.
export function presenceLogins(
  subs: Set<Response> | undefined,
  loginOf: (r: Response) => string | undefined,
): string[] {
  const out = new Set<string>();
  for (const r of subs ?? []) {
    const login = loginOf(r);
    if (login) out.add(login);
  }
  return [...out].sort();
}

export function createServer(deps: {
  manager: ManagerLike;
  turnSubscribers?: Map<string, Set<Response>>;
  identity: IdentityDeps;
  workspace?: string;
  sessions?: SessionService;
  sessionSubscribers?: Map<string, Set<Response>>;
  now?: () => string;
  queue?: TurnQueue;
}): Express {
  const app = express();

  // session id -> SSE responses ("" is the pending bucket for new sessions).
  const subscribers = deps.sessionSubscribers ?? new Map<string, Set<Response>>();
  // turn id -> SSE responses (stream-first: client subscribes before posting).
  const turnSubscribers = deps.turnSubscribers ?? new Map<string, Set<Response>>();
  const now = deps.now ?? (() => new Date().toISOString());

  // Keyed by the response object, so presence survives the "" -> session id
  // re-key: the same responses simply move to the new bucket.
  const subscriberLogin = new WeakMap<Response, string>();

  function broadcastPresence(id: string): void {
    const subs = subscribers.get(id);
    const logins = presenceLogins(subs, (r) => subscriberLogin.get(r));
    for (const r of subs ?? []) writeSseEvent(r, { type: "presence", logins });
  }

  // Lane key -> the session id turns on that lane should resume. Populated when
  // the first turn in a draft room emits its `session` event, so a turn queued
  // before the id existed continues that session instead of starting a new one.
  const laneSession = new Map<string, string>();
  const roomKey = (lane: string): string => laneSession.get(lane) ?? lane;

  // The mapping must not outlive the lane. "" is a process-wide bucket shared by
  // every room whose session id has not arrived yet, so a surviving
  // laneSession[""] would make the NEXT new chat resume the previous chat's
  // session and broadcast into its room. The queue drops its aliases on the same
  // event (`dropLane` in queue.ts), and `subscribers` drops its "" bucket on
  // re-key; this is the third map with that lifetime.
  function forgetLaneSession(sessionId: string): void {
    for (const [lane, id] of laneSession) {
      if (id === sessionId) laneSession.delete(lane);
    }
  }

  const queue =
    deps.queue ??
    createTurnQueue({
      onDepth: (lane, depth) => {
        // Room target must be resolved before any cleanup below, which can
        // remove the very laneSession entry roomKey(lane) would otherwise use.
        const room = roomKey(lane);
        // Depth zero means the lane is empty and idle: no queued turn can still
        // need this mapping, and the queue is about to drop the lane itself.
        // Cleanup runs before the broadcast loop (not after) so a throwing
        // subscriber can never skip it and leave laneSession stale.
        if (depth === 0) {
          forgetLaneSession(lane);
          // forgetLaneSession matches by session-id VALUE. When adoptSession's
          // rekey was refused (both lanes running), laneSession still holds
          // lane -> id but the queue never aliased `lane`, so this lane's own
          // drain-to-zero never matches by value. Delete the lane's own key
          // too, so that orphaned entry doesn't survive to misroute the next
          // draft room.
          laneSession.delete(lane);
        }
        for (const r of subscribers.get(room) ?? []) {
          writeSseEvent(r, { type: "queue", depth });
        }
      },
    });

  // tailscale serve --set-path forwards the original URI, so requests routed
  // through the /agent mount arrive as e.g. /agent/messages. Normalize before
  // any route (including /healthz) sees them.
  app.use((req, _res, next) => {
    req.url = stripAgentPrefix(req.url);
    next();
  });

  // Liveness is unauthenticated; everything after this requires identity
  // (or the control token, in dev mode). Routes mounted later on this app by
  // index.ts (e.g. /infra) sit behind the guard too, since it is registered first.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Identity mode: every route below requires an allowlisted tailnet identity
  // AND the shell header — the agent host has no surface-facing routes, so
  // everything on it is operator-shell territory. Dev mode restores the old
  // optional-control-token behavior exactly.
  if (deps.identity.insecureDev) {
    app.use(createControlTokenGuard(deps.identity.controlToken));
  } else {
    app.use(createIdentityGuard(deps.identity.allowedUsers));
    app.use(requireShellHeader());
  }

  app.use("/files", express.json({ limit: "30mb" }));
  app.use(express.json());

  app.get("/sessions/:id/stream", (req: Request, res: Response) => {
    res.set(SSE_HEADERS);
    res.flushHeaders?.();
    const id = req.params.id;
    subscriberLogin.set(res, readActorLogin(req, deps.identity.insecureDev));
    subsFor(subscribers, id).add(res);
    attachHeartbeat(res, req);
    broadcastPresence(id);
    req.on("close", () => {
      pruneSubscriber(subscribers, id, res);
      broadcastPresence(id);
    });
  });

  app.get("/roster", (_req: Request, res: Response) => {
    res.json({ roster: buildRoster(deps.identity.allowedUsers) });
  });

  app.get("/turns/:turnId/stream", (req: Request, res: Response) => {
    res.set(SSE_HEADERS);
    res.flushHeaders?.();
    const turnId = req.params.turnId;
    subsFor(turnSubscribers, turnId).add(res);
    attachHeartbeat(res, req);
    req.on("close", () => pruneSubscriber(turnSubscribers, turnId, res));
  });

  app.post("/messages", (req: Request, res: Response) => {
    // Destructured as `requestedRoomKey`, not `roomKey`: this scope already has
    // the `roomKey(lane)` helper (lane -> resolved session/pending-bucket id)
    // defined above, and a same-named const here would shadow it for the rest
    // of this handler, breaking every `roomKey(lane)` call below.
    const { sessionId, prompt, turnId, roomKey: requestedRoomKey } = req.body ?? {};
    if (typeof prompt !== "string" || prompt.length === 0) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    if (
      requestedRoomKey !== undefined &&
      (typeof requestedRoomKey !== "string" || !DRAFT_ROOM_KEY_RE.test(requestedRoomKey))
    ) {
      res.status(400).json({ error: "roomKey must be a draft key" });
      return;
    }
    const inputId: string | undefined =
      typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
    const turn: string | undefined =
      typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;

    // Server-derived, never from the body: the room must not be able to lie
    // about who is speaking.
    const author = readActorLogin(req, deps.identity.insecureDev);

    const lane = inputId ?? (typeof requestedRoomKey === "string" ? requestedRoomKey : "");

    // The room sees the question the moment it is accepted. Only one client
    // typed it, but everyone in the session is watching.
    // The sender receives this on BOTH its turn stream and the session stream.
    // Carrying the turnId lets it recognize its own echo by identity rather
    // than by a text-and-recency guess.
    const message: AgentEvent = {
      type: "message",
      author,
      text: prompt,
      ts: now(),
      ...(turn ? { turnId: turn } : {}),
    };
    for (const r of subscribers.get(roomKey(lane)) ?? []) writeSseEvent(r, message);
    if (turn) for (const r of turnSubscribers.get(turn) ?? []) writeSseEvent(r, message);

    queue.enqueue(lane, async () => {
      // Resolved at run time, not enqueue time: a turn queued against a draft
      // room must resume whatever session the turn ahead of it created.
      const resume = inputId ?? laneSession.get(lane);
      let targetId = resume ?? "";

      // Move the room onto its real session id. Subscribers, the lane->session
      // mapping, and the queue lane all follow together; calling it twice with
      // the same id is a no-op.
      const adoptSession = (id: string): void => {
        if (!id || id === targetId) return;
        const pending = subscribers.get(targetId);
        if (pending) {
          const dest = subsFor(subscribers, id);
          for (const r of pending) dest.add(r);
          if (targetId === "") subscribers.delete("");
        }
        laneSession.set(lane, id);
        queue.rekey(lane, id);
        targetId = id;
      };

      const onEvent = (e: AgentEvent) => {
        if (e.type === "session" && e.sessionId) {
          adoptSession(e.sessionId);
          deps.sessions?.upsertFromTurn(e.sessionId, prompt);
        }
        for (const r of subscribers.get(targetId) ?? []) writeSseEvent(r, e);
        if (turn) {
          for (const r of turnSubscribers.get(turn) ?? []) writeSseEvent(r, e);
        }
      };

      // `prompt` stays raw for session titles; only the backend sees the envelope.
      //
      // The `session` event is the normal source of the id, but the AgentBackend
      // contract guarantees only that `run` RETURNS it. Adopting the return value
      // too means a backend that stays quiet cannot leave the next queued turn to
      // start a second session — the exact fork this queue exists to prevent.
      try {
        adoptSession(await deps.manager.run(stampAuthor(author, prompt), resume, onEvent));
      } catch (err) {
        // queue.ts swallows this rejection by design (a failed turn must
        // advance the lane, never wedge it) but the room still needs to know
        // the turn died, or the sender's spinner never stops. Broadcast to the
        // same two buckets `onEvent` writes to, then return so the queue moves
        // on to the next turn.
        const message = err instanceof Error ? err.message : String(err);
        const errorEvent: AgentEvent = { type: "error", message };
        for (const r of subscribers.get(targetId) ?? []) writeSseEvent(r, errorEvent);
        if (turn) for (const r of turnSubscribers.get(turn) ?? []) writeSseEvent(r, errorEvent);
        return;
      }
    });

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
      for (let n = 2; ; n++) {
        try {
          // "wx" = exclusive create: fails with EEXIST instead of overwriting,
          // so concurrent uploads of the same name cannot clobber each other.
          writeFileSync(join(dir, stored), bytes, { flag: "wx" });
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          stored = `${stem}-${n}${ext}`;
        }
      }
      res.json({ path: `uploads/${stored}` });
    });
  }

  const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

  if (deps.sessions) {
    const sessions = deps.sessions;

    app.get("/sessions", (req: Request, res: Response) => {
      res.json({ sessions: sessions.list(req.query.archived === "1") });
    });

    app.get("/sessions/:id/transcript", (req: Request, res: Response) => {
      const id = req.params.id;
      if (!SESSION_ID_RE.test(id)) {
        res.status(400).json({ error: "invalid session id" });
        return;
      }
      const messages = sessions.readTranscript(id);
      if (messages === null) {
        res.status(404).json({ error: "transcript not found" });
        return;
      }
      res.json({ messages });
    });

    app.patch("/sessions/:id", (req: Request, res: Response) => {
      const id = req.params.id;
      const title = (req.body ?? {}).title;
      if (!SESSION_ID_RE.test(id) || typeof title !== "string" || title.length < 1 || title.length > 120) {
        res.status(400).json({ error: "invalid id or title" });
        return;
      }
      res.status(sessions.rename(id, title) ? 204 : 404).end();
    });

    app.post("/sessions/:id/archive", (req: Request, res: Response) => {
      const id = req.params.id;
      if (!SESSION_ID_RE.test(id)) {
        res.status(400).json({ error: "invalid session id" });
        return;
      }
      res.status(sessions.archive(id) ? 204 : 404).end();
    });
  }

  return app;
}
