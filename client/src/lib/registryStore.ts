import type { RegistrySnapshot } from "./types";

export interface Tab {
  id: string;
  title: string;
  url: string;
}

export function reduceRegistry(snapshot: RegistrySnapshot): Tab[] {
  return snapshot.surfaces.map((s) => ({ id: s.id, title: s.title, url: s.url }));
}
