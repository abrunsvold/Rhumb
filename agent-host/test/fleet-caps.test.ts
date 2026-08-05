import { describe, it, expect } from "vitest";
import { loadFleetCaps, checkCaps, capBreachMessage } from "../src/fleet/caps.js";

const CAPS = { maxPerSpawn: 8, maxConcurrent: 8, maxDepth: 1 };

describe("loadFleetCaps", () => {
  it("defaults to 8/8/1", () => {
    expect(loadFleetCaps({})).toEqual(CAPS);
  });

  it("reads overrides", () => {
    expect(loadFleetCaps({
      RHUMB_FLEET_MAX_PER_SPAWN: "3",
      RHUMB_FLEET_MAX_CONCURRENT: "4",
      RHUMB_FLEET_MAX_DEPTH: "2",
    })).toEqual({ maxPerSpawn: 3, maxConcurrent: 4, maxDepth: 2 });
  });

  it("rejects non-numeric and non-positive values at load", () => {
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_PER_SPAWN: "lots" })).toThrow(/RHUMB_FLEET_MAX_PER_SPAWN/);
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_CONCURRENT: "0" })).toThrow(/RHUMB_FLEET_MAX_CONCURRENT/);
    expect(() => loadFleetCaps({ RHUMB_FLEET_MAX_DEPTH: "-1" })).toThrow(/RHUMB_FLEET_MAX_DEPTH/);
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
