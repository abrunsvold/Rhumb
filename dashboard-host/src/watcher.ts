import { scanSurfaces, toSnapshot } from "./registry.js";
import type { RegistrySnapshot } from "./types.js";

export type WatchFn = (
  dir: string,
  onChange: () => void,
) => { close(): void };

export function startWatcher(opts: {
  root: string;
  onSnapshot: (s: RegistrySnapshot) => void;
  watch: WatchFn;
}): { close(): void } {
  const rebuild = () => opts.onSnapshot(toSnapshot(scanSurfaces(opts.root)));
  rebuild(); // initial snapshot
  return opts.watch(opts.root, rebuild);
}
