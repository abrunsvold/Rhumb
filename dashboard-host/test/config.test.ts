import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("fails closed without RHUMB_ALLOWED_USERS", () => {
    expect(() => loadConfig({})).toThrow(/RHUMB_ALLOWED_USERS/);
  });

  it("returns defaults from an empty env (dev mode)", () => {
    expect(loadConfig({ RHUMB_INSECURE_DEV: "1" })).toEqual({
      port: 8788,
      workspace: "./workspace",
      dataSourcesPath: "./workspace/data-sources.json",
      dataTrustPath: "./workspace/data-trust.json",
      dataAuditPath: "./workspace/data-audit.jsonl",
      servicesPath: "./workspace/services.json",
      appOrigins: ["tauri://localhost", "https://tauri.localhost"],
      allowedUsers: [],
      insecureDev: true,
    });
  });

  it("honors overrides", () => {
    expect(
      loadConfig({ RHUMB_DASHBOARD_PORT: "9100", RHUMB_WORKSPACE: "/srv/ws", RHUMB_INSECURE_DEV: "1" }),
    ).toEqual({
      port: 9100,
      workspace: "/srv/ws",
      dataSourcesPath: "/srv/ws/data-sources.json",
      dataTrustPath: "/srv/ws/data-trust.json",
      dataAuditPath: "/srv/ws/data-audit.jsonl",
      servicesPath: "/srv/ws/services.json",
      appOrigins: ["tauri://localhost", "https://tauri.localhost"],
      allowedUsers: [],
      insecureDev: true,
    });
  });

  it("throws when RHUMB_DASHBOARD_PORT is not numeric", () => {
    expect(() => loadConfig({ RHUMB_DASHBOARD_PORT: "abc", RHUMB_INSECURE_DEV: "1" })).toThrow(
      /RHUMB_DASHBOARD_PORT/,
    );
  });

  it("defaults appOrigins to the Tauri origins and parses RHUMB_APP_ORIGINS", () => {
    expect(loadConfig({ RHUMB_INSECURE_DEV: "1" }).appOrigins).toEqual(["tauri://localhost", "https://tauri.localhost"]);
    expect(loadConfig({ RHUMB_APP_ORIGINS: "tauri://localhost, http://x:1", RHUMB_INSECURE_DEV: "1" }).appOrigins)
      .toEqual(["tauri://localhost", "http://x:1"]);
  });

  it("parses the allowlist and dev flag", () => {
    const cfg = loadConfig({ RHUMB_ALLOWED_USERS: "Op@Example.com" });
    expect(cfg.allowedUsers).toEqual(["op@example.com"]);
    expect(cfg.insecureDev).toBe(false);
  });
});
