import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults from an empty env", () => {
    expect(loadConfig({})).toEqual({ port: 8788, workspace: "./workspace" });
  });

  it("honors overrides", () => {
    expect(
      loadConfig({ RHUMBR_DASHBOARD_PORT: "9100", RHUMBR_WORKSPACE: "/srv/ws" }),
    ).toEqual({ port: 9100, workspace: "/srv/ws" });
  });

  it("throws when RHUMBR_DASHBOARD_PORT is not numeric", () => {
    expect(() => loadConfig({ RHUMBR_DASHBOARD_PORT: "abc" })).toThrow(
      /RHUMBR_DASHBOARD_PORT/,
    );
  });
});
