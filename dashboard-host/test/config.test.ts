import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults from an empty env", () => {
    expect(loadConfig({})).toEqual({
      port: 8788,
      workspace: "./workspace",
      dataSourcesPath: "./workspace/data-sources.json",
      dataTrustPath: "./workspace/data-trust.json",
      dataAuditPath: "./workspace/data-audit.jsonl",
      servicesPath: "./workspace/services.json",
    });
  });

  it("honors overrides", () => {
    expect(
      loadConfig({ RHUMB_DASHBOARD_PORT: "9100", RHUMB_WORKSPACE: "/srv/ws" }),
    ).toEqual({
      port: 9100,
      workspace: "/srv/ws",
      dataSourcesPath: "/srv/ws/data-sources.json",
      dataTrustPath: "/srv/ws/data-trust.json",
      dataAuditPath: "/srv/ws/data-audit.jsonl",
      servicesPath: "/srv/ws/services.json",
    });
  });

  it("throws when RHUMB_DASHBOARD_PORT is not numeric", () => {
    expect(() => loadConfig({ RHUMB_DASHBOARD_PORT: "abc" })).toThrow(
      /RHUMB_DASHBOARD_PORT/,
    );
  });
});
