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

/** What an operator writes in `ANTHROPIC_AUTH_TOKEN` to declare "this gateway
 *  needs no auth". Compared case-insensitively against the trimmed value. */
export const GATEWAY_NO_AUTH_SENTINEL = "none";

/** What Rhumb actually injects for the sentinel. It must be non-empty so the
 *  CLI never consults the on-disk credential store (see the gateway branch of
 *  `loadProvider`), and it is deliberately self-describing rather than the
 *  literal `none`: it shows up in gateway access logs as
 *  `Authorization: Bearer rhumb-no-auth`, which reads unambiguously as "Rhumb
 *  was configured for an auth-free gateway" instead of looking like a real
 *  token that happens to be named `none`. It is not a secret and never was. */
export const GATEWAY_NO_AUTH_PLACEHOLDER = "rhumb-no-auth";

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
  if (!authToken) {
    // Fail closed. Claude Code builds the gateway's Authorization header as
    // `process.env.ANTHROPIC_AUTH_TOKEN || <stored credential>` — with no env
    // value it falls back to the operator's stored claude.ai OAuth login (macOS
    // keychain / ~/.claude/.credentials.json) and sends it to whatever host
    // ANTHROPIC_BASE_URL names. `sanitizedEnv` cannot prevent that: the
    // fallback reads the on-disk credential store, not the environment, and
    // HOME is deliberately preserved for the agent. The only reliable defence
    // is to always hand the child a non-empty ANTHROPIC_AUTH_TOKEN.
    throw new Error(
      "ANTHROPIC_AUTH_TOKEN is required for RHUMB_LLM_PROVIDER=gateway. Set it to " +
        "the credential your gateway expects, or to the literal value " +
        `\`${GATEWAY_NO_AUTH_SENTINEL}\` if your gateway genuinely needs no auth. It ` +
        "cannot be left empty: without an auth token in the environment, Claude Code " +
        "falls back to the operator's stored claude.ai login and would transmit it to " +
        "the gateway as a bearer token.",
    );
  }
  return {
    id,
    model,
    credentialEnv: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN:
        authToken.toLowerCase() === GATEWAY_NO_AUTH_SENTINEL ? GATEWAY_NO_AUTH_PLACEHOLDER : authToken,
    },
  };
}
