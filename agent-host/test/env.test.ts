import { describe, it, expect } from "vitest";
import { sanitizedEnv } from "../src/env.js";

describe("sanitizedEnv", () => {
  it("removes ANTHROPIC_API_KEY from the returned env", () => {
    const input: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "sk-ant-test",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    };
    const result = sanitizedEnv(input);
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("removes ANTHROPIC_AUTH_TOKEN from the returned env", () => {
    const input: NodeJS.ProcessEnv = {
      ANTHROPIC_AUTH_TOKEN: "bearer-test",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    };
    const result = sanitizedEnv(input);
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("preserves CLAUDE_CODE_OAUTH_TOKEN and other vars", () => {
    const input: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "sk-ant-test",
      CLAUDE_CODE_OAUTH_TOKEN: "my-oauth-token",
      PATH: "/usr/bin:/bin",
      HOME: "/home/user",
    };
    const result = sanitizedEnv(input);
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe("my-oauth-token");
    expect(result.PATH).toBe("/usr/bin:/bin");
    expect(result.HOME).toBe("/home/user");
  });

  it("does not mutate the input object", () => {
    const input: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_AUTH_TOKEN: "bearer-test",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    };
    sanitizedEnv(input);
    expect(input.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(input.ANTHROPIC_AUTH_TOKEN).toBe("bearer-test");
  });
});
