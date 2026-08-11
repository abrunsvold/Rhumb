/** Hard bounds on model-directed spawning. Enforced in the tool handler BEFORE
 *  any `mngr create` runs, so a model that ignores its instructions still
 *  cannot exceed them. Never enforced by prompt. */
export interface FleetCaps {
  maxPerSpawn: number;
  maxConcurrent: number;
  maxDepth: number;
  /** Ceiling on a single `collect` call's model-supplied `waitMs` (review
   *  finding 2). `waitMs` is the one model-directed quantity the host did
   *  not bound: uncapped, a model passing a day's worth of milliseconds
   *  holds the MCP tool call — and the foreground turn — open for a day of
   *  polls against any agent reporting "working". Clamped in
   *  `createFleetOps().collect`, never left to the model's judgment. */
  maxCollectWaitMs: number;
}

const DEFAULTS: FleetCaps = {
  maxPerSpawn: 8,
  maxConcurrent: 8,
  maxDepth: 1,
  maxCollectWaitMs: 10 * 60_000,
};

// Strict: the whole trimmed value must be one or more ASCII digits. This
// rejects "3.7" (truncation), "1e3" (parseInt stops at "e", silently giving
// 1 instead of 1000), "5abc" (trailing garbage), and a leading "+" (not
// accepted — callers must write bare digits). Number.parseInt alone accepts
// all of these and *silently truncates toward a smaller cap*, which is safe
// (never bypasses a limit) but is a real operator footgun: a typo'd env var
// produces a wrongly-small cap with no diagnostic pointing at the typo.
const DIGITS_ONLY = /^\d+$/;

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!DIGITS_ONLY.test(raw)) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  const n = Number.parseInt(raw, 10);
  if (n < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return n;
}

export function loadFleetCaps(env: NodeJS.ProcessEnv): FleetCaps {
  return {
    maxPerSpawn: positiveInt(env, "RHUMB_FLEET_MAX_PER_SPAWN", DEFAULTS.maxPerSpawn),
    maxConcurrent: positiveInt(env, "RHUMB_FLEET_MAX_CONCURRENT", DEFAULTS.maxConcurrent),
    maxDepth: positiveInt(env, "RHUMB_FLEET_MAX_DEPTH", DEFAULTS.maxDepth),
    maxCollectWaitMs: positiveInt(env, "RHUMB_FLEET_MAX_COLLECT_WAIT_MS", DEFAULTS.maxCollectWaitMs),
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
    default: {
      // Exhaustiveness guard: if CapBreach["cap"] gains a variant and this
      // switch isn't updated, this line fails to compile (no noImplicitReturns
      // in tsconfig, so an unhandled case would otherwise return `undefined`
      // silently at runtime instead of a string).
      const _exhaustive: never = b.cap;
      throw new Error(`capBreachMessage: unhandled cap "${_exhaustive}"`);
    }
  }
}
