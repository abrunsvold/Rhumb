import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadServiceConfig } from "../src/services/config.js";

describe("loadConfig", () => {
  it("throws when CLAUDE_CODE_OAUTH_TOKEN is missing", () => {
    expect(() => loadConfig({})).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("rejects an API key as a substitute for the subscription token", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "sk-ant-xxx" })).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });

  it("returns defaults when only the token is set", () => {
    const cfg = loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: "tok", RHUMB_INSECURE_DEV: "1" });
    expect(cfg).toEqual({
      port: 8787,
      model: "claude-opus-4-8",
      workspace: "./workspace",
      oauthToken: "tok",
      permissionMode: "acceptEdits",
      allowedUsers: [],
      insecureDev: true,
    });
  });

  it("honors overrides", () => {
    const cfg = loadConfig({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      RHUMB_PORT: "9000",
      RHUMB_MODEL: "claude-sonnet-4-6",
      RHUMB_WORKSPACE: "/srv/ws",
      RHUMB_INSECURE_DEV: "1",
    });
    expect(cfg).toEqual({
      port: 9000,
      model: "claude-sonnet-4-6",
      workspace: "/srv/ws",
      oauthToken: "tok",
      permissionMode: "acceptEdits",
      allowedUsers: [],
      insecureDev: true,
    });
  });

  it("throws when RHUMB_PORT is not numeric", () => {
    expect(() =>
      loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: "tok", RHUMB_PORT: "abc", RHUMB_INSECURE_DEV: "1" }),
    ).toThrow(/RHUMB_PORT/);
  });

  it("honors RHUMB_PERMISSION_MODE override", () => {
    const cfg = loadConfig({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      RHUMB_PERMISSION_MODE: "plan",
      RHUMB_INSECURE_DEV: "1",
    });
    expect(cfg.permissionMode).toBe("plan");
  });

  it("throws when RHUMB_PERMISSION_MODE is invalid", () => {
    expect(() =>
      loadConfig({
        CLAUDE_CODE_OAUTH_TOKEN: "tok",
        RHUMB_PERMISSION_MODE: "turbo",
        RHUMB_INSECURE_DEV: "1",
      }),
    ).toThrow(/RHUMB_PERMISSION_MODE/);
  });
});

describe("identity config", () => {
  const base = { CLAUDE_CODE_OAUTH_TOKEN: "tok" };

  it("parses RHUMB_ALLOWED_USERS into a lowercased list", () => {
    const cfg = loadConfig({ ...base, RHUMB_ALLOWED_USERS: " Op@Example.com , second@example.com ,, " });
    expect(cfg.allowedUsers).toEqual(["op@example.com", "second@example.com"]);
    expect(cfg.insecureDev).toBe(false);
  });

  it("fails closed: throws without RHUMB_ALLOWED_USERS in identity mode", () => {
    expect(() => loadConfig({ ...base })).toThrow(/RHUMB_ALLOWED_USERS/);
  });

  it("RHUMB_INSECURE_DEV=1 permits an empty allowlist", () => {
    const cfg = loadConfig({ ...base, RHUMB_INSECURE_DEV: "1" });
    expect(cfg.insecureDev).toBe(true);
    expect(cfg.allowedUsers).toEqual([]);
  });
});

describe("loadServiceConfig healthGateMs", () => {
  const base = {
    RHUMB_DEPLOY_KEY: "/k",
    RHUMB_LXC_TEMPLATE: "t",
    RHUMB_LXC_STORAGE: "s",
    RHUMB_LXC_BRIDGE: "b",
  };

  it("honors RHUMB_HEALTH_GATE_MS", () => {
    const cfg = loadServiceConfig({ ...base, RHUMB_HEALTH_GATE_MS: "120000" });
    expect(cfg?.healthGateMs).toBe(120_000);
  });

  it("defaults healthGateMs to 90000 when absent", () => {
    const cfg = loadServiceConfig({ ...base });
    expect(cfg?.healthGateMs).toBe(90_000);
  });
});

describe("RHUMB_WATCHDOG_MINUTES", () => {
  const base = { CLAUDE_CODE_OAUTH_TOKEN: "tok", RHUMB_INSECURE_DEV: "1" };
  it("parses a positive integer interval", () => {
    expect(loadConfig({ ...base, RHUMB_WATCHDOG_MINUTES: "30" }).watchdogMinutes).toBe(30);
  });
  it("is off when unset, zero, negative, or garbage", () => {
    expect(loadConfig({ ...base }).watchdogMinutes).toBeNull();
    expect(loadConfig({ ...base, RHUMB_WATCHDOG_MINUTES: "0" }).watchdogMinutes).toBeNull();
    expect(loadConfig({ ...base, RHUMB_WATCHDOG_MINUTES: "-5" }).watchdogMinutes).toBeNull();
    expect(loadConfig({ ...base, RHUMB_WATCHDOG_MINUTES: "soon" }).watchdogMinutes).toBeNull();
  });
});
