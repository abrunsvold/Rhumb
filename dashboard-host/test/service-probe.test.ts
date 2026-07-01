import { describe, it, expect } from "vitest";
import { probeOnce } from "../src/services/probe.js";

describe("probeOnce", () => {
  it("writes healthy/unhealthy per service based on the probe result", async () => {
    const services = [{ id: "up", host: "h", port: 1 }, { id: "down", host: "h", port: 2 }] as any[];
    const written: Array<[string, string]> = [];
    await probeOnce({
      getServices: () => services,
      probe: async (s) => s.id === "up",
      writeStatus: (id, status) => written.push([id, status]),
    });
    expect(written).toEqual([["up", "healthy"], ["down", "unhealthy"]]);
  });
});
