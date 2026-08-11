import { describe, it, expect } from "vitest";
import { loadFleetCaps, checkCaps, capBreachMessage } from "../src/fleet/caps.js";

const CAPS = { maxPerSpawn: 8, maxConcurrent: 8, maxDepth: 1, maxCollectWaitMs: 600_000 };

describe("loadFleetCaps", () => {
  it("defaults to 8/8/1 with a 10-minute collect-wait ceiling", () => {
    expect(loadFleetCaps({})).toEqual(CAPS);
  });

  it("reads overrides", () => {
    expect(loadFleetCaps({
      RHUMB_FLEET_MAX_PER_SPAWN: "3",
      RHUMB_FLEET_MAX_CONCURRENT: "4",
      RHUMB_FLEET_MAX_DEPTH: "2",
      RHUMB_FLEET_MAX_COLLECT_WAIT_MS: "30000",
    })).toEqual({ maxPerSpawn: 3, maxConcurrent: 4, maxDepth: 2, maxCollectWaitMs: 30_000 });
  });

  it("rejects a malformed collect-wait ceiling at load, like every other cap", () => {
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_COLLECT_WAIT_MS: "forever" })).toThrow(
      /RHUMB_FLEET_MAX_COLLECT_WAIT_MS/,
    );
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_COLLECT_WAIT_MS: "0" })).toThrow(
      /RHUMB_FLEET_MAX_COLLECT_WAIT_MS/,
    );
  });

  it("rejects non-numeric and non-positive values at load", () => {
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_PER_SPAWN: "lots" })).toThrow(/RHUMB_FLEET_MAX_PER_SPAWN/);
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_CONCURRENT: "0" })).toThrow(/RHUMB_FLEET_MAX_CONCURRENT/);
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_DEPTH: "-1" })).toThrow(/RHUMB_FLEET_MAX_DEPTH/);
  });

  it("rejects malformed-but-parseInt-truncatable values instead of silently truncating (F1)", () => {
    // "3.7" would parseInt to 3, "1e3" would parseInt to 1 (not 1000!),
    // "5abc" would parseInt to 5, "+5" would parseInt to 5. All of these must
    // throw, naming the offending variable, rather than silently accepting a
    // truncated/misleading number.
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_PER_SPAWN: "3.7" })).toThrow(/RHUMB_FLEET_MAX_PER_SPAWN/);
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_PER_SPAWN: "1e3" })).toThrow(/RHUMB_FLEET_MAX_PER_SPAWN/);
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_PER_SPAWN: "5abc" })).toThrow(/RHUMB_FLEET_MAX_PER_SPAWN/);
    // Deliberate choice: a leading "+" is rejected — only bare digits are accepted.
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_PER_SPAWN: "+5" })).toThrow(/RHUMB_FLEET_MAX_PER_SPAWN/);
  });
});

describe("checkCaps — boundaries", () => {
  it("allows exactly the limit and rejects one more (perSpawn)", () => {
    expect(checkCaps({ caps: CAPS, requested: 8, liveCount: 0, depth: 0 })).toBeNull();
    expect(checkCaps({ caps: CAPS, requested: 9, liveCount: 0, depth: 0 }))
      .toEqual({ cap: "perSpawn", limit: 8, actual: 9 });
  });

  it("counts requested PLUS already-live against maxConcurrent", () => {
    expect(checkCaps({ caps: CAPS, requested: 3, liveCount: 5, depth: 0 })).toBeNull();
    expect(checkCaps({ caps: CAPS, requested: 4, liveCount: 5, depth: 0 }))
      .toEqual({ cap: "concurrent", limit: 8, actual: 9 });
  });

  it("rejects a spawn that would exceed maxDepth", () => {
    expect(checkCaps({ caps: CAPS, requested: 1, liveCount: 0, depth: 0 })).toBeNull();
    expect(checkCaps({ caps: CAPS, requested: 1, liveCount: 0, depth: 1 }))
      .toEqual({ cap: "depth", limit: 1, actual: 2 });
  });

  it("message names the cap and the numbers", () => {
    expect(capBreachMessage({ cap: "concurrent", limit: 8, actual: 9 }))
      .toMatch(/concurrent.*8.*9|9.*8/i);
  });
});
