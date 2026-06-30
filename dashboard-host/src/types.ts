export interface SurfaceMeta {
  id: string;
  title: string;
  kind: "file";
  entry: string;
  created: string;
  updated: string;
}

export interface RegistryEntry {
  id: string;
  title: string;
  url: string;
  kind: string;
  created: string;
  updated: string;
}

export interface RegistrySnapshot {
  surfaces: RegistryEntry[];
}

export type RegistryEvent = { type: "registry" } & RegistrySnapshot;
