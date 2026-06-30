import type { AgentEvent } from "./types.js";

export function writeSseEvent(
  res: { write(chunk: string): void },
  event: AgentEvent,
): void {
  // JSON.stringify produces a single line (newlines become \n), keeping the
  // SSE frame to one `data:` line followed by the mandatory blank line.
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
