import type { AgentEvent } from "./types.js";

export function writeSseEvent(
  res: { write(chunk: string): void },
  event: AgentEvent,
): void {
  // JSON.stringify produces a single line (newlines become \n), keeping the
  // SSE frame to one `data:` line followed by the mandatory blank line.
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// SSE comment frame: keeps the socket alive during long silent turns without
// reaching the client reducer (comment lines carry no `data:` payload). Lets the
// client treat prolonged byte-silence as a genuinely dead connection.
export function heartbeatFrame(): string {
  return ":keepalive\n\n";
}

export function attachHeartbeat(
  res: { write(s: string): void },
  req: { on(ev: "close", cb: () => void): void },
  ms = 15000,
  timers: { set: typeof setInterval; clear: typeof clearInterval } = { set: setInterval, clear: clearInterval },
): () => void {
  const id = timers.set(() => res.write(heartbeatFrame()), ms);
  const clear = () => timers.clear(id);
  req.on("close", clear);
  return clear;
}
