/** Returns a copy of `base` with API-key credentials stripped so the spawned
 *  Claude Code process authenticates only via the subscription token. */
export function sanitizedEnv(
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}
