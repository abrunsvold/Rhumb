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

  it("strips infrastructure secrets (RHUMBR_* vars) from the child env", () => {
    const input: NodeJS.ProcessEnv = {
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      RHUMBR_PROXMOX_TOKEN_SECRET: "super-secret",
      RHUMBR_PROXMOX_TOKEN_ID: "rhumbr@pve!t1",
      RHUMBR_PROXMOX_URL: "https://pve:8006",
      RHUMBR_PROXMOX_NODE: "pve",
      RHUMBR_PG_ADMIN: "postgres://admin:pw@pg:5432/postgres",
      RHUMBR_WORKSPACE: "/srv/ws",
      PATH: "/usr/bin:/bin",
    };
    const result = sanitizedEnv(input);
    // No RHUMBR_* var survives — the spawned agent cannot read infra credentials
    // and shell out (ungated Bash) to bypass the operator-confirmation gate.
    for (const key of Object.keys(result)) {
      expect(key.startsWith("RHUMBR_")).toBe(false);
    }
    expect(result.RHUMBR_PROXMOX_TOKEN_SECRET).toBeUndefined();
    expect(result.RHUMBR_PG_ADMIN).toBeUndefined();
    // The subscription token and ordinary vars are preserved.
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect(result.PATH).toBe("/usr/bin:/bin");
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
