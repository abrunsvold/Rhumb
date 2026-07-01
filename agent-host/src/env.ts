/** Returns a copy of `base` with credentials stripped so the spawned Claude Code
 *  process authenticates only via the subscription token and cannot read the
 *  operator's infrastructure secrets.
 *
 *  Two classes are removed:
 *   - `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` — force subscription auth.
 *   - every `RHUMB_*` var — these are the agent host's own config (the scoped
 *     Proxmox token, the PG admin connection string, workspace/path settings).
 *     The host consumes them in-process; the spawned agent never needs them.
 *     Stripping the whole prefix keeps the gating boundary intact: without the
 *     raw credentials in its env, the model cannot shell out (ungated `Bash`)
 *     to Proxmox/Postgres directly and bypass the operator-confirmation gate,
 *     and any future `RHUMB_*` secret is stripped by default. */
export function sanitizedEnv(
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  for (const key of Object.keys(env)) {
    if (key.startsWith("RHUMB_")) delete env[key];
  }
  return env;
}
