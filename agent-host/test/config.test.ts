import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

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
    const cfg = loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(cfg).toEqual({
      port: 8787,
      model: "claude-opus-4-8",
      workspace: "./workspace",
      oauthToken: "tok",
    });
  });

  it("honors overrides", () => {
    const cfg = loadConfig({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      RHUMBR_PORT: "9000",
      RHUMBR_MODEL: "claude-sonnet-4-6",
      RHUMBR_WORKSPACE: "/srv/ws",
    });
    expect(cfg).toEqual({
      port: 9000,
      model: "claude-sonnet-4-6",
      workspace: "/srv/ws",
      oauthToken: "tok",
    });
  });
});
