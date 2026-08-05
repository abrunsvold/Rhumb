/** Hard bounds on model-directed spawning. Enforced in the tool handler BEFORE
 *  any `mngr create` runs, so a model that ignores its instructions still
 *  cannot exceed them. Never enforced by prompt. */
export interface FleetCaps {
  maxPerSpawn: number;
  maxConcurrent: number;
  maxDepth: number;
}

const DEFAULTS: FleetCaps = { maxPerSpawn: 8, maxConcurrent: 8, maxDepth: 1 };

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return n;
}

export function loadFleetCaps(env: NodeJS.ProcessEnv): FleetCaps {
  return {
    maxPerSpawn: positiveInt(env, "RHUMB_FLEET_MAX_PER_SPAWN", DEFAULTS.maxPerSpawn),
    maxConcurrent: positiveInt(env, "RHUMB_FLEET_MAX_CONCURRENT", DEFAULTS.maxConcurrent),
    maxDepth: positiveInt(env, "RHUMB_FLEET_MAX_DEPTH", DEFAULTS.maxDepth),
  };
}

export type CapBreach = {
  cap: "perSpawn" | "concurrent" | "depth";
  limit: number;
  actual: number;
};

/** Returns the FIRST breach, or null when the spawn is allowed. `depth` is the
 *  depth of the SPAWNING principal; children land at depth + 1. */
export function checkCaps(deps: {
  caps: FleetCaps;
  requested: number;
  liveCount: number;
  depth: number;
}): CapBreach | null {
  const { caps, requested, liveCount, depth } = deps;
  if (requested > caps.maxPerSpawn) {
    return { cap: "perSpawn", limit: caps.maxPerSpawn, actual: requested };
  }
  if (liveCount + requested > caps.maxConcurrent) {
    return { cap: "concurrent", limit: caps.maxConcurrent, actual: liveCount + requested };
  }
  if (depth + 1 > caps.maxDepth) {
    return { cap: "depth", limit: caps.maxDepth, actual: depth + 1 };
  }
  return null;
}

export function capBreachMessage(b: CapBreach): string {
  switch (b.cap) {
    case "perSpawn":
      return `fleet: ${b.actual} tasks requested, limit ${b.limit} per spawn`;
    case "concurrent":
      return `fleet: would bring ${b.actual} agents live, limit ${b.limit} concurrent`;
    case "depth":
      return `fleet: spawn would reach depth ${b.actual}, limit ${b.limit}`;
  }
}
