import { describe, it, expect } from "vitest";
import { sanitizedEnv } from "../src/env.js";

describe("sanitizedEnv", () => {
  it("injects the selected provider's credentials", () => {
    const result = sanitizedEnv({ PATH: "/usr/bin" }, { ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(result.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });

  it("strips credential vars that are not the selected provider's", () => {
    const input: NodeJS.ProcessEnv = {
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      ANTHROPIC_API_KEY: "sk-ant-ambient",
      ANTHROPIC_AUTH_TOKEN: "bearer-ambient",
      CLAUDE_CODE_USE_BEDROCK: "1",
    };
    const result = sanitizedEnv(input, { ANTHROPIC_API_KEY: "sk-ant-selected" });
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(result.ANTHROPIC_API_KEY).toBe("sk-ant-selected");
  });

  it("an ambient ANTHROPIC_BASE_URL cannot redirect the agent", () => {
    const result = sanitizedEnv(
      { ANTHROPIC_BASE_URL: "https://attacker.example" },
      { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    );
    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("preserves ordinary environment vars", () => {
    const result = sanitizedEnv(
      { PATH: "/usr/bin:/bin", HOME: "/home/user" },
      { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    );
    expect(result.PATH).toBe("/usr/bin:/bin");
    expect(result.HOME).toBe("/home/user");
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });

  it("strips infrastructure secrets (RHUMB_* vars) from the child env", () => {
    const input: NodeJS.ProcessEnv = {
      RHUMB_PROXMOX_TOKEN_SECRET: "super-secret",
      RHUMB_PROXMOX_TOKEN_ID: "rhumb@pve!t1",
      RHUMB_PROXMOX_URL: "https://pve:8006",
      RHUMB_PG_ADMIN: "postgres://admin:pw@pg:5432/postgres",
      RHUMB_WORKSPACE: "/srv/ws",
      PATH: "/usr/bin:/bin",
    };
    const result = sanitizedEnv(input, { CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    // No RHUMB_* var survives — the spawned agent cannot read infra credentials
    // and shell out (ungated Bash) to bypass the operator-confirmation gate.
    for (const key of Object.keys(result)) {
      expect(key.startsWith("RHUMB_")).toBe(false);
    }
    expect(result.RHUMB_PROXMOX_TOKEN_SECRET).toBeUndefined();
    expect(result.RHUMB_PG_ADMIN).toBeUndefined();
    expect(result.PATH).toBe("/usr/bin:/bin");
  });

  it("does not mutate the input object", () => {
    const input: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-test", RHUMB_PG_ADMIN: "pg" };
    sanitizedEnv(input, { CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(input.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(input.RHUMB_PG_ADMIN).toBe("pg");
  });
});
