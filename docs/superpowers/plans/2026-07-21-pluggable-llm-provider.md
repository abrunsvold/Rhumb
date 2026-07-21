# Pluggable LLM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rhumb's Claude credential mode an explicit, validated choice — subscription OAuth, Anthropic API key, or a gateway base URL — instead of hard-coding subscription auth.

**Architecture:** A new `provider.ts` module owns credential-mode selection and produces a `ProviderConfig` carrying the model plus exactly the env vars the spawned agent should receive. `loadConfig` delegates to it. `sanitizedEnv` flips from a blocklist ("delete API keys") to an allowlist ("strip every known credential var, then inject the selected one"), which preserves the existing blast-radius property and additionally makes an ambient `ANTHROPIC_BASE_URL` unable to redirect agent traffic. The installer and docs follow.

**Tech Stack:** TypeScript (strict), Node ≥ 20, Express 4, `@anthropic-ai/claude-agent-sdk`, Vitest, POSIX sh (installer).

**Spec:** [`docs/superpowers/specs/2026-07-21-pluggable-llm-provider-design.md`](../specs/2026-07-21-pluggable-llm-provider-design.md)

## Global Constraints

- TypeScript strict mode; all new modules are ESM with `.js` import specifiers (match existing files).
- Never log credential values. The startup log may name the provider id and model only.
- `RHUMB_LLM_PROVIDER` unset MUST mean `subscription`, with behavior byte-identical to today — the deployed box's existing `/etc/rhumb/rhumb.env` has no such var and must keep booting.
- Valid provider ids, exactly: `subscription`, `api-key`, `gateway`.
- The agent process must never receive any `RHUMB_*` var, in any provider mode.
- Conventional commit messages; commit at the end of every task.
- Run tests from the `agent-host/` directory.

---

### Task 1: Provider module

**Files:**
- Create: `agent-host/src/provider.ts`
- Test: `agent-host/test/provider.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type ProviderId = "subscription" | "api-key" | "gateway"`
  - `interface ProviderConfig { id: ProviderId; model: string; credentialEnv: Record<string, string> }`
  - `function loadProvider(env: NodeJS.ProcessEnv): ProviderConfig`
  - `const DEFAULT_MODEL = "claude-opus-4-8"`
  - `const PROVIDER_CREDENTIAL_VARS: readonly string[]` — every credential var Rhumb knows about, exported here so `env.ts` (Task 3) strips exactly this set.

- [ ] **Step 1: Write the failing test**

Create `agent-host/test/provider.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadProvider } from "../src/provider.js";

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
  };

  it("accepts a base URL and explicit model", () => {
    const p = loadProvider({ ...base });
    expect(p.id).toBe("gateway");
    expect(p.model).toBe("qwen3-coder");
    expect(p.credentialEnv).toEqual({ ANTHROPIC_BASE_URL: "https://gw.internal:4000" });
  });

  it("includes ANTHROPIC_AUTH_TOKEN when present", () => {
    const p = loadProvider({ ...base, ANTHROPIC_AUTH_TOKEN: "bearer-xyz" });
    expect(p.credentialEnv).toEqual({
      ANTHROPIC_BASE_URL: "https://gw.internal:4000",
      ANTHROPIC_AUTH_TOKEN: "bearer-xyz",
    });
  });

  it("throws when ANTHROPIC_BASE_URL is missing", () => {
    expect(() => loadProvider({ RHUMB_LLM_PROVIDER: "gateway", RHUMB_MODEL: "m" })).toThrow(
      /ANTHROPIC_BASE_URL/,
    );
  });

  it("throws when RHUMB_MODEL is missing — no default is safe here", () => {
    expect(() =>
      loadProvider({ RHUMB_LLM_PROVIDER: "gateway", ANTHROPIC_BASE_URL: "https://gw:4000" }),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-host && npx vitest run test/provider.test.ts`
Expected: FAIL — `Failed to resolve import "../src/provider.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `agent-host/src/provider.ts`:

```ts
/** Which credential mode the agent host authenticates Claude with.
 *
 *  Subscription auth (an OAuth token from `claude setup-token`) is the default
 *  and carries Anthropic's personal-tool restriction — see COMPLIANCE.md. The
 *  other modes are ordinary credentials with no such restriction. Selection is
 *  explicit via RHUMB_LLM_PROVIDER; unset means `subscription` so that installs
 *  predating this variable keep booting unchanged. */
export type ProviderId = "subscription" | "api-key" | "gateway";

export interface ProviderConfig {
  id: ProviderId;
  model: string;
  /** Exactly the credential vars handed to the spawned Claude Code process.
   *  `env.ts` strips every known credential var and then injects this. */
  credentialEnv: Record<string, string>;
}

export const DEFAULT_MODEL = "claude-opus-4-8";

/** Every credential var Rhumb knows how to set. `sanitizedEnv` strips all of
 *  them before injecting the selected provider's, so an ambient value can never
 *  reach the agent — in particular an ambient ANTHROPIC_BASE_URL cannot silently
 *  redirect model traffic to an endpoint nobody configured. */
export const PROVIDER_CREDENTIAL_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

const VALID_IDS: readonly ProviderId[] = ["subscription", "api-key", "gateway"];

function required(env: NodeJS.ProcessEnv, name: string, hint: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for RHUMB_LLM_PROVIDER=${env.RHUMB_LLM_PROVIDER?.trim() || "subscription"}. ${hint}`);
  return value;
}

export function loadProvider(env: NodeJS.ProcessEnv): ProviderConfig {
  const raw = env.RHUMB_LLM_PROVIDER?.trim();
  const id = (raw || "subscription") as ProviderId;
  if (!VALID_IDS.includes(id)) {
    throw new Error(
      `RHUMB_LLM_PROVIDER must be one of subscription|api-key|gateway, got "${raw}".`,
    );
  }

  const model = env.RHUMB_MODEL?.trim();

  if (id === "subscription") {
    const token = required(
      env,
      "CLAUDE_CODE_OAUTH_TOKEN",
      "Generate one with `claude setup-token`, or pick another mode with RHUMB_LLM_PROVIDER.",
    );
    return { id, model: model || DEFAULT_MODEL, credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: token } };
  }

  if (id === "api-key") {
    const key = required(env, "ANTHROPIC_API_KEY", "Create one at console.anthropic.com.");
    return { id, model: model || DEFAULT_MODEL, credentialEnv: { ANTHROPIC_API_KEY: key } };
  }

  const baseUrl = required(
    env,
    "ANTHROPIC_BASE_URL",
    "Point it at an Anthropic-compatible endpoint (e.g. a LiteLLM proxy).",
  );
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`ANTHROPIC_BASE_URL must be a valid URL, got "${baseUrl}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`ANTHROPIC_BASE_URL must use http or https, got "${parsed.protocol}".`);
  }
  if (!model) {
    // No default is safe: `claude-opus-4-8` against a proxy serving Qwen or
    // Llama is a silent misconfiguration that surfaces much later as a
    // confusing model error. Fail at startup instead.
    throw new Error(
      "RHUMB_MODEL is required for RHUMB_LLM_PROVIDER=gateway — set it to a model id your gateway serves.",
    );
  }
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
  return {
    id,
    model,
    credentialEnv: {
      ANTHROPIC_BASE_URL: baseUrl,
      ...(authToken ? { ANTHROPIC_AUTH_TOKEN: authToken } : {}),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-host && npx vitest run test/provider.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/provider.ts agent-host/test/provider.test.ts
git commit -m "feat(agent-host): add pluggable LLM provider module"
```

---

### Task 2: Wire the provider into `loadConfig`

**Files:**
- Modify: `agent-host/src/config.ts:1-20` (interface + token check), `agent-host/src/config.ts:63-70` (return object)
- Test: `agent-host/test/config.test.ts:5-30` (replace the two subscription-only tests and both `toEqual` shapes)

**Interfaces:**
- Consumes: `loadProvider`, `ProviderConfig` from Task 1.
- Produces: `Config` with `provider: ProviderConfig` replacing `oauthToken: string` and `model: string`. Consumers read `config.provider.model`.

- [ ] **Step 1: Update the failing tests**

In `agent-host/test/config.test.ts`, add the import:

```ts
import { loadProvider } from "../src/provider.js";
```

Replace the first two tests in `describe("loadConfig")`:

```ts
  it("throws when no credential is present for the default provider", () => {
    expect(() => loadConfig({})).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("accepts an API key when that provider is selected", () => {
    const cfg = loadConfig({
      RHUMB_LLM_PROVIDER: "api-key",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      RHUMB_INSECURE_DEV: "1",
    });
    expect(cfg.provider.id).toBe("api-key");
    expect(cfg.provider.credentialEnv).toEqual({ ANTHROPIC_API_KEY: "sk-ant-xxx" });
  });
```

In `"returns defaults when only the token is set"`, replace the expected object's
`model` and `oauthToken` keys with a single `provider` key:

```ts
    expect(cfg).toEqual({
      port: 8787,
      workspace: "./workspace",
      provider: { id: "subscription", model: "claude-opus-4-8", credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } },
      permissionMode: "acceptEdits",
      allowedUsers: [],
      insecureDev: true,
      watchdogMinutes: null,
    });
```

In `"honors overrides"`, make the same substitution:

```ts
    expect(cfg).toEqual({
      port: 9000,
      workspace: "/srv/ws",
      provider: { id: "subscription", model: "claude-sonnet-4-6", credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } },
      permissionMode: "acceptEdits",
      allowedUsers: [],
      insecureDev: true,
      watchdogMinutes: null,
    });
```

Leave every other test in the file untouched — the ones that pass only
`CLAUDE_CODE_OAUTH_TOKEN` are the regression test for the unset-means-subscription
default and must keep passing without edits.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent-host && npx vitest run test/config.test.ts`
Expected: FAIL — `cfg.provider` is undefined; the `toEqual` comparisons report an unexpected `oauthToken` key.

- [ ] **Step 3: Update the implementation**

In `agent-host/src/config.ts`, add the import at the top:

```ts
import { loadProvider, type ProviderConfig } from "./provider.js";
```

Change the interface — delete the `model` and `oauthToken` lines, add `provider`:

```ts
export interface Config {
  port: number;
  workspace: string;
  provider: ProviderConfig;
  permissionMode: string;
  controlToken?: string;
  allowedUsers: string[];
  insecureDev: boolean;
  watchdogMinutes: number | null;
}
```

Delete the entire OAuth token block at the top of `loadConfig` (the
`const oauthToken = ...` declaration and the `if (!oauthToken) throw ...` that
mentions `ANTHROPIC_API_KEY`) and replace it with:

```ts
  const provider = loadProvider(env);
```

In the returned object, delete the `model:` and `oauthToken:` lines and add:

```ts
    provider,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent-host && npx vitest run test/config.test.ts`
Expected: PASS. TypeScript will still fail to build — `index.ts` references `config.model`, fixed in Task 4.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/config.ts agent-host/test/config.test.ts
git commit -m "feat(agent-host): select credential mode via loadProvider in loadConfig"
```

---

### Task 3: `sanitizedEnv` becomes allowlist-driven

**Files:**
- Modify: `agent-host/src/env.ts` (whole file)
- Test: `agent-host/test/env.test.ts` (whole file)

**Interfaces:**
- Consumes: `PROVIDER_CREDENTIAL_VARS` from Task 1.
- Produces: `sanitizedEnv(base: NodeJS.ProcessEnv, credentialEnv: Record<string, string>): NodeJS.ProcessEnv` — second parameter is required.

- [ ] **Step 1: Write the failing tests**

Replace the whole body of `agent-host/test/env.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent-host && npx vitest run test/env.test.ts`
Expected: FAIL — the injection and stripping tests fail because `sanitizedEnv` ignores its second argument.

- [ ] **Step 3: Write the implementation**

Replace the whole of `agent-host/src/env.ts`:

```ts
import { PROVIDER_CREDENTIAL_VARS } from "./provider.js";

/** Returns a copy of `base` carrying exactly one provider's credentials, so the
 *  spawned Claude Code process authenticates the way the operator configured and
 *  cannot read the operator's infrastructure secrets.
 *
 *  Three classes are removed before `credentialEnv` is applied:
 *   - every credential var in PROVIDER_CREDENTIAL_VARS — an ambient value must
 *     never reach the agent. This is an allowlist, not a blocklist: notably an
 *     ambient ANTHROPIC_BASE_URL would otherwise silently redirect all model
 *     traffic to an endpoint nobody configured.
 *   - every `RHUMB_*` var — these are the agent host's own config (the scoped
 *     Proxmox token, the PG admin connection string, workspace/path settings).
 *     The host consumes them in-process; the spawned agent never needs them.
 *     Stripping the whole prefix keeps the gating boundary intact: without the
 *     raw credentials in its env, the model cannot shell out (ungated `Bash`)
 *     to Proxmox/Postgres directly and bypass the operator-confirmation gate,
 *     and any future `RHUMB_*` secret is stripped by default. */
export function sanitizedEnv(
  base: NodeJS.ProcessEnv,
  credentialEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of PROVIDER_CREDENTIAL_VARS) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith("RHUMB_")) delete env[key];
  }
  return { ...env, ...credentialEnv };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent-host && npx vitest run test/env.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/env.ts agent-host/test/env.test.ts
git commit -m "feat(agent-host): allowlist provider credentials in sanitizedEnv"
```

---

### Task 4: Wire the provider through `index.ts`

**Files:**
- Modify: `agent-host/src/index.ts:167`, `:199` (model reads), `:226-231` (`realQuery`), `:233-236` (`main`), `:245` (startup log)
- Test: `agent-host/test/index.smoke.test.ts` (no edits expected — see Step 1)

**Interfaces:**
- Consumes: `Config.provider` from Task 2, `sanitizedEnv(base, credentialEnv)` from Task 3.
- Produces: `createRealQuery(credentialEnv: Record<string, string>): QueryFn`, replacing the module-level `realQuery` const. `buildApp`'s signature is unchanged.

The existing `realQuery` is a module-level const with no access to config, so it
cannot reach `provider.credentialEnv`. It becomes a factory called from `main()`.

- [ ] **Step 1: Run the full suite to see the current breakage**

Run: `cd agent-host && npx vitest run`
Expected: FAIL — TypeScript errors in `index.ts` for `deps.config.model` (property does not exist) and for `sanitizedEnv` being called with one argument.

Note: `index.smoke.test.ts` builds its configs with `as never` casts and never sets
`model`, so it needs no edits. If any assertion there does fail, fix the test to
supply `provider: { id: "subscription", model: "claude-opus-4-8", credentialEnv: {} }`
rather than changing `buildApp`.

- [ ] **Step 2: Update the model reads**

At `agent-host/src/index.ts:167` (the `SessionManager` construction) change:

```ts
    model: deps.config.model,
```

to:

```ts
    model: deps.config.provider.model,
```

Make the identical change at `:199` (the watchdog `SessionManager`).

- [ ] **Step 3: Convert `realQuery` into a factory**

Replace lines 225-231 (the comment and the `realQuery` const):

```ts
// Wrap the SDK's query so it matches our narrowed QueryFn signature. The env we
// hand the SDK is what the spawned Claude Code process sees: the selected
// provider's credentials and nothing else (see sanitizedEnv).
export function createRealQuery(credentialEnv: Record<string, string>): QueryFn {
  return (args) =>
    sdkQuery({
      ...args,
      options: { ...args.options, env: sanitizedEnv(process.env, credentialEnv) },
    } as never);
}
```

- [ ] **Step 4: Update `main()`**

Replace the two-line comment about the SDK reading `CLAUDE_CODE_OAUTH_TOKEN` and
the `buildApp` call:

```ts
export function main(): void {
  const config = loadConfig(process.env);
  // Credentials reach the SDK only through the env we build per query — the
  // host's own process env is never passed through unfiltered.
  mkdirSync(config.workspace, { recursive: true });
  const app = buildApp({ config, query: createRealQuery(config.provider.credentialEnv) });
```

- [ ] **Step 5: Update the startup log**

At `agent-host/src/index.ts:245`, change:

```ts
    console.log(`rhumb agent-host listening on ${bound}:${config.port} (model ${config.model})`);
```

to:

```ts
    console.log(
      `rhumb agent-host listening on ${bound}:${config.port} ` +
        `(provider ${config.provider.id}, model ${config.provider.model})`,
    );
```

Log the provider id only. Never log anything from `credentialEnv`.

- [ ] **Step 6: Run the full suite**

Run: `cd agent-host && npx vitest run && npm run build`
Expected: PASS, and a clean TypeScript build.

- [ ] **Step 7: Commit**

```bash
git add agent-host/src/index.ts agent-host/test/index.smoke.test.ts
git commit -m "feat(agent-host): pass provider credentials to the spawned agent"
```

---

### Task 5: Installer supports all three modes

**Files:**
- Modify: `scripts/install.sh:87-88` (claude CLI check), `:112-128` (re-run config load), `:160-164` (credential prompts), `:174` (model prompt), `:186-196` (env file body)
- Test: `scripts/test/install-dry-run.sh`

**Interfaces:**
- Consumes: the provider ids from Task 1.
- Produces: an `/etc/rhumb/rhumb.env` containing `RHUMB_LLM_PROVIDER` plus only the selected mode's credential vars.

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/test/install-dry-run.sh`, before the final success message:

```bash
# --- api-key mode: writes the key, writes no OAuth token ---
STAGE_API="$(mktemp -d)"
RHUMB_LLM_PROVIDER=api-key ANTHROPIC_API_KEY=sk-ant-test-1 \
RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE_API" >/dev/null
grep -q '^RHUMB_LLM_PROVIDER=api-key$'    "$STAGE_API/rhumb.env" || fail "provider not written"
grep -q '^ANTHROPIC_API_KEY=sk-ant-test-1$' "$STAGE_API/rhumb.env" || fail "api key not written"
grep -q '^CLAUDE_CODE_OAUTH_TOKEN='       "$STAGE_API/rhumb.env" && fail "oauth token leaked into api-key install"

# --- api-key mode requires the key ---
if RHUMB_LLM_PROVIDER=api-key ANTHROPIC_API_KEY='' RHUMB_ALLOWED_USERS=bob@github \
   scripts/install.sh --dry-run --yes --stage-dir "$(mktemp -d)" >/dev/null 2>&1; then
  fail "empty API key should be rejected"
fi

# --- gateway mode: base URL plus explicit model, optional auth token ---
STAGE_GW="$(mktemp -d)"
RHUMB_LLM_PROVIDER=gateway ANTHROPIC_BASE_URL=https://gw.internal:4000 \
RHUMB_MODEL=qwen3-coder ANTHROPIC_AUTH_TOKEN=bearer-xyz \
RHUMB_ALLOWED_USERS=alice@github \
  scripts/install.sh --dry-run --yes --stage-dir "$STAGE_GW" >/dev/null
grep -q '^RHUMB_LLM_PROVIDER=gateway$'                "$STAGE_GW/rhumb.env" || fail "gateway provider not written"
grep -q '^ANTHROPIC_BASE_URL=https://gw.internal:4000$' "$STAGE_GW/rhumb.env" || fail "base url not written"
grep -q '^ANTHROPIC_AUTH_TOKEN=bearer-xyz$'           "$STAGE_GW/rhumb.env" || fail "gateway auth token not written"
grep -q '^RHUMB_MODEL=qwen3-coder$'                   "$STAGE_GW/rhumb.env" || fail "gateway model not written"
grep -q '^CLAUDE_CODE_OAUTH_TOKEN='                   "$STAGE_GW/rhumb.env" && fail "oauth token leaked into gateway install"

# --- gateway re-run is byte-identical (idempotence across the new branch) ---
cp "$STAGE_GW/rhumb.env" "$STAGE_GW/rhumb.env.first"
scripts/install.sh --dry-run --yes --stage-dir "$STAGE_GW" >/dev/null
cmp -s "$STAGE_GW/rhumb.env.first" "$STAGE_GW/rhumb.env" || fail "gateway re-run not byte-identical"

# --- unknown provider is rejected ---
if RHUMB_LLM_PROVIDER=ollama RHUMB_ALLOWED_USERS=bob@github \
   scripts/install.sh --dry-run --yes --stage-dir "$(mktemp -d)" >/dev/null 2>&1; then
  fail "unknown provider should be rejected"
fi

rm -rf "$STAGE_API" "$STAGE_GW"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash scripts/test/install-dry-run.sh`
Expected: FAIL at `provider not written` — the installer has no provider concept yet.

- [ ] **Step 3: Make the `claude` CLI check subscription-only**

Replace `scripts/install.sh:87-88`:

```sh
if [ "${RHUMB_LLM_PROVIDER:-subscription}" = subscription ]; then
  command -v claude >/dev/null 2>&1 \
    || warn "claude CLI not found on this box — fine: run 'claude setup-token' on any machine and paste the token below"
fi
```

- [ ] **Step 4: Read existing provider values on re-run**

In the re-run config load block, add to the `CUR_*` declarations:

```sh
CUR_PROVIDER=""
CUR_API_KEY=""
CUR_BASE_URL=""
CUR_AUTH_TOKEN=""
```

and inside `if [ -f "$ENV_FILE" ]; then`, after the existing `env_get` calls:

```sh
  CUR_PROVIDER="$(env_get RHUMB_LLM_PROVIDER)"
  CUR_API_KEY="$(env_get ANTHROPIC_API_KEY)"
  CUR_BASE_URL="$(env_get ANTHROPIC_BASE_URL)"
  CUR_AUTH_TOKEN="$(env_get ANTHROPIC_AUTH_TOKEN)"
```

- [ ] **Step 5: Branch the credential prompts**

Replace the `CLAUDE_CODE_OAUTH_TOKEN` prompt block (`install.sh:160-164`) with:

```sh
prompt RHUMB_LLM_PROVIDER "Credential mode (subscription|api-key|gateway)" \
  "${RHUMB_LLM_PROVIDER:-${CUR_PROVIDER:-subscription}}"
case "$RHUMB_LLM_PROVIDER" in
  subscription)
    prompt CLAUDE_CODE_OAUTH_TOKEN "Claude OAuth token (from 'claude setup-token')" \
      "${CLAUDE_CODE_OAUTH_TOKEN:-$CUR_TOKEN}" secret
    [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] \
      || die "CLAUDE_CODE_OAUTH_TOKEN is required — run 'claude setup-token' on any machine, then re-run the installer"
    ;;
  api-key)
    prompt ANTHROPIC_API_KEY "Anthropic API key" \
      "${ANTHROPIC_API_KEY:-$CUR_API_KEY}" secret
    [ -n "$ANTHROPIC_API_KEY" ] \
      || die "ANTHROPIC_API_KEY is required for RHUMB_LLM_PROVIDER=api-key — create one at console.anthropic.com"
    ;;
  gateway)
    prompt ANTHROPIC_BASE_URL "Gateway base URL (Anthropic-compatible endpoint)" \
      "${ANTHROPIC_BASE_URL:-$CUR_BASE_URL}"
    [ -n "$ANTHROPIC_BASE_URL" ] \
      || die "ANTHROPIC_BASE_URL is required for RHUMB_LLM_PROVIDER=gateway — see docs/setup-manual.md"
    prompt ANTHROPIC_AUTH_TOKEN "Gateway auth token (blank if the gateway needs none)" \
      "${ANTHROPIC_AUTH_TOKEN:-$CUR_AUTH_TOKEN}" secret
    ;;
  *)
    die "RHUMB_LLM_PROVIDER must be one of subscription|api-key|gateway, got \"$RHUMB_LLM_PROVIDER\""
    ;;
esac
```

- [ ] **Step 6: Require an explicit model in gateway mode**

Replace the `RHUMB_MODEL` prompt (`install.sh:174`) with:

```sh
if [ "$RHUMB_LLM_PROVIDER" = gateway ]; then
  prompt RHUMB_MODEL "Model id your gateway serves (no default is safe here)" \
    "${RHUMB_MODEL:-$CUR_MODEL}"
  [ -n "$RHUMB_MODEL" ] \
    || die "RHUMB_MODEL is required for RHUMB_LLM_PROVIDER=gateway — set it to a model id your gateway serves"
else
  prompt RHUMB_MODEL "Claude model" "${RHUMB_MODEL:-${CUR_MODEL:-claude-opus-4-8}}"
fi
```

- [ ] **Step 7: Write only the selected mode's vars**

In the env-file heredoc, replace the `CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN`
line with `RHUMB_LLM_PROVIDER=$RHUMB_LLM_PROVIDER`, then immediately after the
heredoc that ends with `$MARKER`, insert the credential lines before the optional
section. Concretely, inside the `{ ... }` group, after the first `cat <<EOF ... EOF`
block, add:

```sh
  case "$RHUMB_LLM_PROVIDER" in
    subscription) printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_CODE_OAUTH_TOKEN" ;;
    api-key)      printf 'ANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY" ;;
    gateway)
      printf 'ANTHROPIC_BASE_URL=%s\n' "$ANTHROPIC_BASE_URL"
      [ -n "$ANTHROPIC_AUTH_TOKEN" ] && printf 'ANTHROPIC_AUTH_TOKEN=%s\n' "$ANTHROPIC_AUTH_TOKEN"
      ;;
  esac
```

Move the `$MARKER` line so it is emitted *after* this case block — the marker must
stay the last line before the optional section, or re-run preservation breaks.

- [ ] **Step 8: Run the dry-run test**

Run: `bash scripts/test/install-dry-run.sh`
Expected: PASS, including the pre-existing subscription-mode assertions (which
prove the default path is unchanged).

- [ ] **Step 9: Commit**

```bash
git add scripts/install.sh scripts/test/install-dry-run.sh
git commit -m "feat(install): prompt for credential mode and write only its vars"
```

---

### Task 6: Documentation accuracy pass

**Files:**
- Modify: `README.md:37` (the personal-tool section), `README.md:78-80` (quickstart)
- Modify: `COMPLIANCE.md:8-30` (core constraint + how Rhumb stays inside it)
- Modify: `docs/setup-manual.md:12-17` (get a token), `:36-50` (run the agent host)
- Modify: `SECURITY.md:45` (credential list)
- Modify: `agent-host/README.md:8`, `:15`, `:31-32` (auth line + env vars)

**Interfaces:**
- Consumes: the provider ids and required vars from Task 1.
- Produces: no code.

- [ ] **Step 1: Rewrite the README's constraint section**

Replace the section body at `README.md:37` (keeping the surrounding heading
structure) with a three-mode table and a scoped caveat:

```markdown
Rhumb authenticates Claude one of three ways, selected with `RHUMB_LLM_PROVIDER`:

| `RHUMB_LLM_PROVIDER` | Credentials | Notes |
|---|---|---|
| `subscription` (default) | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Uses your existing Claude subscription rather than pay-per-token billing. Carries the personal-tool constraint below. |
| `api-key` | `ANTHROPIC_API_KEY` | Ordinary pay-per-token API access. No personal-tool constraint. |
| `gateway` | `ANTHROPIC_BASE_URL`, optional `ANTHROPIC_AUTH_TOKEN`, explicit `RHUMB_MODEL` | Point Rhumb at an Anthropic-compatible endpoint — a LiteLLM proxy, an internal gateway, or a self-hosted open model behind one. Nothing need leave your network. |

**The personal-tool constraint applies to `subscription` mode only.** That mode
authenticates with an OAuth token tied to your own Claude subscription, and
Anthropic's terms restrict third-party developers from *offering* claude.ai login
or rate limits to other people inside their own products. So in subscription mode
Rhumb is built around the single-operator model — your hardware, your credentials,
no "sign in with Claude" layer for anyone else.

In `api-key` and `gateway` mode that restriction does not apply: those are ordinary
credentials governed by whatever terms you hold with the relevant provider. See
[COMPLIANCE.md](COMPLIANCE.md) for the full reasoning.
```

- [ ] **Step 2: Update the quickstart**

At `README.md:78-80`, replace the `claude setup-token` line with a note that it is
mode-specific:

```sh
git clone https://github.com/abrunsvold/Rhumb && cd Rhumb
claude setup-token      # subscription mode only — the installer also accepts an API key or a gateway URL
sudo scripts/install.sh
```

Change the Prerequisites sentence to end with "and Claude credentials (a
subscription, an API key, or an Anthropic-compatible gateway)" in place of "and a
Claude subscription".

- [ ] **Step 3: Scope COMPLIANCE.md to subscription mode**

Replace the "## The core constraint" section body with:

```markdown
Rhumb supports three credential modes (`RHUMB_LLM_PROVIDER`): `subscription`,
`api-key`, and `gateway`. **This document's constraint applies to `subscription`
mode only.**

In subscription mode, Rhumb authenticates Claude with the **operator's own Claude
subscription**, via a long-lived OAuth token produced by `claude setup-token`
(`CLAUDE_CODE_OAUTH_TOKEN`).

Anthropic's terms of service restrict third-party developers from **offering**
claude.ai login or claude.ai rate limits within their own products — including
agents built on the Claude Agent SDK — without prior approval. The operative verb
is **offer**: the restriction is about exposing *your* Claude access (or a login to
it) *to other people* as part of a product or service.

In `api-key` and `gateway` mode no claude.ai login or rate limit is involved, so
this restriction does not apply. Those deployments are governed by the terms you
hold with whoever supplies the credentials — Anthropic, your cloud provider, or
nobody at all if you are serving a self-hosted model.
```

In "## How Rhumb stays inside that line", change the opening to "In subscription
mode, Rhumb is built and distributed as a **self-hosted personal tool**…" and
change the "One operator, their own credentials" bullet to begin "**One operator,
their own credentials.** Each person running Rhumb in subscription mode supplies
their own `CLAUDE_CODE_OAUTH_TOKEN`…".

In "## If you want to go further", change the first sentence to: "Building a
**multi-tenant or hosted** offering on top of Rhumb **in subscription mode** —
anything where people who are not the operator reach *your* claude.ai access
through your deployment — moves outside this personal-tool model. **Seek
Anthropic's approval first.**"

- [ ] **Step 4: Add per-mode setup to the manual**

Replace `docs/setup-manual.md` step "### 1. Get a Claude token" with:

````markdown
### 1. Choose a credential mode

Rhumb authenticates Claude one of three ways, set with `RHUMB_LLM_PROVIDER`:

```sh
# subscription (default) — uses your Claude subscription
claude setup-token        # produces a long-lived CLAUDE_CODE_OAUTH_TOKEN

# api-key — pay-per-token API access
export RHUMB_LLM_PROVIDER=api-key ANTHROPIC_API_KEY=sk-ant-...

# gateway — any Anthropic-compatible endpoint, including self-hosted models
export RHUMB_LLM_PROVIDER=gateway \
       ANTHROPIC_BASE_URL=https://gateway.internal:4000 \
       ANTHROPIC_AUTH_TOKEN=...   # omit if your gateway needs none
export RHUMB_MODEL=qwen3-coder    # required in gateway mode — no default is safe
```

> **Gateway mode needs an Anthropic-compatible endpoint.** Rhumb drives Claude Code
> through `@anthropic-ai/claude-agent-sdk`, which speaks the Anthropic Messages
> API. OpenRouter and most local servers (ollama, vLLM) are OpenAI-compatible, so
> put a translating proxy in front — [LiteLLM](https://github.com/BerriAI/litellm),
> claude-code-router, or equivalent. Rhumb does not translate protocols itself.

> **Tool-calling fidelity is the real limiter on open models.** Rhumb's agent loop
> is tool-heavy: it provisions databases, spawns services, and writes through a
> gated approval path. Models that handle prose well often still fail at reliable
> multi-step tool use, and that shows up as an agent that stalls or loops rather
> than one that writes bad text. Test with a small build before committing.
````

In the "run the agent host" step, replace the `npm start` line with:

```sh
CLAUDE_CODE_OAUTH_TOKEN=... RHUMB_ALLOWED_USERS=you@github npm start   # or the api-key / gateway vars above
```

and change the "Defaults:" sentence to read "Defaults: port `8787`, provider
`subscription`, model `claude-opus-4-8` (subscription and api-key modes only),
workspace `./workspace`, permission mode `acceptEdits`."

- [ ] **Step 5: Update SECURITY.md and agent-host/README.md**

At `SECURITY.md:45`, change the credential bullet to:

```markdown
- **Credentials come only from the environment**, never from the repo. Keep your
  Claude credentials (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or
  `ANTHROPIC_AUTH_TOKEN` depending on `RHUMB_LLM_PROVIDER`), Proxmox tokens, and
  database credentials in a local `.env` or your process manager — they are
  git-ignored by default. The agent subprocess receives only the selected
  provider's credentials and no `RHUMB_*` var.
```

At `agent-host/README.md:8`, change "Rhumb authenticates Claude with **your own
Claude subscription**, not an API key." to "Rhumb authenticates Claude with your
own subscription, an API key, or an Anthropic-compatible gateway — set
`RHUMB_LLM_PROVIDER` (`subscription` | `api-key` | `gateway`; default
`subscription`)."

At `agent-host/README.md:31-32`, change the environment-variables sentence to:
"Environment variables: `RHUMB_LLM_PROVIDER` (default `subscription`) plus that
mode's credentials — `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`, or
`ANTHROPIC_BASE_URL` (+ optional `ANTHROPIC_AUTH_TOKEN`); `RHUMB_PORT` (default
8787), `RHUMB_MODEL` (default `claude-opus-4-8`; required in gateway mode),
`RHUMB_WORKSPACE`".

- [ ] **Step 6: Verify no stale claims remain**

Run: `grep -rn "not an API key\|does not use ANTHROPIC_API_KEY\|only.*subscription" README.md COMPLIANCE.md SECURITY.md agent-host/README.md docs/setup-manual.md`
Expected: no hits asserting subscription auth is the only mode. Fix any that remain.

- [ ] **Step 7: Commit**

```bash
git add README.md COMPLIANCE.md SECURITY.md agent-host/README.md docs/setup-manual.md
git commit -m "docs: scope the personal-tool constraint to subscription mode"
```

---

## Final verification

- [ ] `cd agent-host && npx vitest run` — full suite passes.
- [ ] `cd agent-host && npm run build` — clean TypeScript build.
- [ ] `bash scripts/test/install-dry-run.sh` — passes.
- [ ] **Live check on the box, in this order.** Redeploy with the *unchanged*
  `/etc/rhumb/rhumb.env` first and confirm `rhumb-agent` starts and completes a
  turn — that is the regression that matters most, since the deployed env file has
  no `RHUMB_LLM_PROVIDER`. Confirm the startup log reads
  `(provider subscription, model claude-opus-4-8)`.
- [ ] **Then** set `RHUMB_LLM_PROVIDER=api-key` with an `ANTHROPIC_API_KEY`,
  restart, and complete a real turn with no OAuth token anywhere in the
  environment. Restore the subscription config afterward.
