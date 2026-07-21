import { PROVIDER_CREDENTIAL_VARS } from "./provider.js";

/** Vars that are not credentials but that let an ambient value smuggle one
 *  back into the agent, so they are stripped alongside PROVIDER_CREDENTIAL_VARS.
 *  Kept as a separate list because they must never be *injectable*:
 *  PROVIDER_CREDENTIAL_VARS doubles as the allowlist for `credentialEnv`, and
 *  neither of these is something Rhumb should ever be setting.
 *
 *   - CLAUDE_ENV_FILE — the CLI sources this file's contents into the session
 *     environment used by the Bash tool. Pointed at /etc/rhumb/rhumb.env it
 *     would reintroduce RHUMB_PG_ADMIN and RHUMB_PROXMOX_TOKEN_SECRET into the
 *     agent's shell, defeating the RHUMB_* strip below and with it the
 *     operator-confirmation gate.
 *   - CLAUDE_CODE_SHELL_PREFIX — prefixes every Bash command the agent runs, so
 *     an ambient value rewrites every shell invocation (and can read the child's
 *     environment or exfiltrate its arguments). */
export const STRIPPED_ENV_VARS = ["CLAUDE_ENV_FILE", "CLAUDE_CODE_SHELL_PREFIX"] as const;

/** Returns a copy of `base` carrying exactly one provider's credentials, so the
 *  spawned Claude Code process authenticates the way the operator configured and
 *  cannot read the operator's infrastructure secrets.
 *
 *  Three classes are removed before `credentialEnv` is applied:
 *   - every var in PROVIDER_CREDENTIAL_VARS — an ambient credential or
 *     provider-selection value must never reach the agent. Notably an ambient
 *     ANTHROPIC_BASE_URL or CLAUDE_CODE_USE_FOUNDRY would otherwise silently
 *     redirect all model traffic to an endpoint nobody configured.
 *   - every var in STRIPPED_ENV_VARS — see above.
 *   - every `RHUMB_*` var — these are the agent host's own config (the scoped
 *     Proxmox token, the PG admin connection string, workspace/path settings).
 *     The host consumes them in-process; the spawned agent never needs them.
 *     Stripping the whole prefix keeps the gating boundary intact: without the
 *     raw credentials in its env, the model cannot shell out (ungated `Bash`)
 *     to Proxmox/Postgres directly and bypass the operator-confirmation gate,
 *     and any future `RHUMB_*` secret is stripped by default.
 *
 *  What this is NOT: an allowlist over the ambient environment. Everything not
 *  named above passes through — including HTTPS_PROXY and NODE_EXTRA_CA_CERTS,
 *  deliberately, because corporate networks need them, and both can redirect or
 *  intercept model traffic. The guarantee this function actually provides is
 *  narrower and worth stating exactly: no `RHUMB_*` var and no credential or
 *  provider-selection var Rhumb knows about reaches the agent from the ambient
 *  environment. Only `credentialEnv` is allowlist-validated.
 *
 *  @throws if `credentialEnv` contains a key outside PROVIDER_CREDENTIAL_VARS.
 *          `createRealQuery` calls this once eagerly at process start so the
 *          mistake surfaces there rather than on the first user turn. */
export function sanitizedEnv(
  base: NodeJS.ProcessEnv,
  credentialEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of PROVIDER_CREDENTIAL_VARS) delete env[key];
  for (const key of STRIPPED_ENV_VARS) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith("RHUMB_")) delete env[key];
  }

  // Defense in depth: the passes above strip everything from `base`, but the
  // security guarantee still depends on `credentialEnv` itself staying narrow.
  // `provider.ts` builds it narrowly today, but nothing stops a future caller
  // from spreading a broader config object into it and silently reintroducing
  // a RHUMB_* var or an unlisted credential. Enforce the allowlist here too,
  // and fail closed (throw) rather than silently drop — a dropped credential
  // would surface later as a confusing auth failure at runtime, whereas a
  // throw surfaces the mistake immediately, where the operator is looking.
  for (const key of Object.keys(credentialEnv)) {
    if (!(PROVIDER_CREDENTIAL_VARS as readonly string[]).includes(key)) {
      throw new Error(
        `sanitizedEnv: credentialEnv contains disallowed key "${key}" — only ` +
          `${PROVIDER_CREDENTIAL_VARS.join(", ")} may be injected into the agent's environment.`,
      );
    }
  }

  return { ...env, ...credentialEnv };
}
