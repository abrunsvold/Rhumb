import { describe, it, expect } from "vitest";
import { loadProvider, GATEWAY_NO_AUTH_PLACEHOLDER } from "../src/provider.js";

describe("loadProvider — subscription", () => {
  it("defaults to subscription when RHUMB_LLM_PROVIDER is unset", () => {
    const p = loadProvider({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(p.id).toBe("subscription");
    expect(p.model).toBe("claude-opus-4-8");
    expect(p.credentialEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  });

  it("throws when the OAuth token is missing", () => {
    expect(() => loadProvider({ RHUMB_LLM_PROVIDER: "subscription" })).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });

  it("does not mention ANTHROPIC_API_KEY in its error", () => {
    expect(() => loadProvider({})).not.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("honors RHUMB_MODEL", () => {
    const p = loadProvider({ CLAUDE_CODE_OAUTH_TOKEN: "tok", RHUMB_MODEL: "claude-sonnet-4-6" });
    expect(p.model).toBe("claude-sonnet-4-6");
  });
});

describe("loadProvider — api-key", () => {
  it("accepts an API key and carries only that credential", () => {
    const p = loadProvider({ RHUMB_LLM_PROVIDER: "api-key", ANTHROPIC_API_KEY: "sk-ant-xxx" });
    expect(p.id).toBe("api-key");
    expect(p.model).toBe("claude-opus-4-8");
    expect(p.credentialEnv).toEqual({ ANTHROPIC_API_KEY: "sk-ant-xxx" });
  });

  it("throws when the API key is missing", () => {
    expect(() => loadProvider({ RHUMB_LLM_PROVIDER: "api-key" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("ignores an ambient OAuth token", () => {
    const p = loadProvider({
      RHUMB_LLM_PROVIDER: "api-key",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    });
    expect(p.credentialEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("loadProvider — gateway", () => {
  const base = {
    RHUMB_LLM_PROVIDER: "gateway",
    ANTHROPIC_BASE_URL: "https://gw.internal:4000",
    RHUMB_MODEL: "qwen3-coder",
    ANTHROPIC_AUTH_TOKEN: "bearer-xyz",
  };

  it("accepts a base URL and explicit model", () => {
    const p = loadProvider({ ...base });
    expect(p.id).toBe("gateway");
    expect(p.model).toBe("qwen3-coder");
    expect(p.credentialEnv).toEqual({
      ANTHROPIC_BASE_URL: "https://gw.internal:4000",
      ANTHROPIC_AUTH_TOKEN: "bearer-xyz",
    });
  });

  // Fail closed: with no ANTHROPIC_AUTH_TOKEN in the child env, Claude Code
  // falls back to the operator's stored claude.ai OAuth credential and sends
  // it to the gateway as `Authorization: Bearer sk-ant-oat01-...`.
  it("refuses to start when ANTHROPIC_AUTH_TOKEN is missing", () => {
    const { ANTHROPIC_AUTH_TOKEN: _omit, ...noToken } = base;
    expect(() => loadProvider(noToken)).toThrow(/ANTHROPIC_AUTH_TOKEN is required/);
  });

  it("names both options in the missing-token error", () => {
    const { ANTHROPIC_AUTH_TOKEN: _omit, ...noToken } = base;
    expect(() => loadProvider(noToken)).toThrow(/`none`/);
    expect(() => loadProvider(noToken)).toThrow(/claude\.ai login/);
  });

  it("treats a whitespace-only auth token as missing", () => {
    expect(() => loadProvider({ ...base, ANTHROPIC_AUTH_TOKEN: "   " })).toThrow(
      /ANTHROPIC_AUTH_TOKEN is required/,
    );
  });

  it("maps the `none` sentinel to a non-empty placeholder", () => {
    const p = loadProvider({ ...base, ANTHROPIC_AUTH_TOKEN: "none" });
    expect(p.credentialEnv.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY_NO_AUTH_PLACEHOLDER);
    expect(p.credentialEnv.ANTHROPIC_AUTH_TOKEN).not.toBe("");
  });

  it("accepts the sentinel case-insensitively and with surrounding space", () => {
    const p = loadProvider({ ...base, ANTHROPIC_AUTH_TOKEN: "  NONE " });
    expect(p.credentialEnv.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY_NO_AUTH_PLACEHOLDER);
  });

  it("includes ANTHROPIC_AUTH_TOKEN when present", () => {
    const p = loadProvider({ ...base, ANTHROPIC_AUTH_TOKEN: "bearer-xyz" });
    expect(p.credentialEnv).toEqual({
      ANTHROPIC_BASE_URL: "https://gw.internal:4000",
      ANTHROPIC_AUTH_TOKEN: "bearer-xyz",
    });
  });

  it("throws when ANTHROPIC_BASE_URL is missing", () => {
    expect(() =>
      loadProvider({ RHUMB_LLM_PROVIDER: "gateway", RHUMB_MODEL: "m", ANTHROPIC_AUTH_TOKEN: "t" }),
    ).toThrow(/ANTHROPIC_BASE_URL/);
  });

  it("throws when RHUMB_MODEL is missing — no default is safe here", () => {
    expect(() =>
      loadProvider({
        RHUMB_LLM_PROVIDER: "gateway",
        ANTHROPIC_BASE_URL: "https://gw:4000",
        ANTHROPIC_AUTH_TOKEN: "t",
      }),
    ).toThrow(/RHUMB_MODEL/);
  });

  it("rejects a non-URL base", () => {
    expect(() => loadProvider({ ...base, ANTHROPIC_BASE_URL: "not a url" })).toThrow(
      /ANTHROPIC_BASE_URL/,
    );
  });

  it("rejects a non-http scheme", () => {
    expect(() => loadProvider({ ...base, ANTHROPIC_BASE_URL: "file:///etc/passwd" })).toThrow(
      /ANTHROPIC_BASE_URL/,
    );
  });
});

describe("loadProvider — validation", () => {
  it("rejects an unknown provider and lists the valid ones", () => {
    expect(() => loadProvider({ RHUMB_LLM_PROVIDER: "ollama" })).toThrow(
      /subscription.*api-key.*gateway/s,
    );
  });

  it("treats whitespace-only credentials as missing", () => {
    expect(() => loadProvider({ CLAUDE_CODE_OAUTH_TOKEN: "   " })).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });
});
