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
