import type { RegistryEvent } from "./types.js";

export function writeSseEvent(
  res: { write(chunk: string): void },
  event: RegistryEvent,
): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
