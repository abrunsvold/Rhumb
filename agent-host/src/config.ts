export interface Config {
  port: number;
  model: string;
  workspace: string;
  oauthToken: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!oauthToken) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN is required. Generate one with `claude setup-token` " +
        "(uses your Claude subscription). RHUMBR does not use ANTHROPIC_API_KEY.",
    );
  }
  return {
    port: env.RHUMBR_PORT ? Number(env.RHUMBR_PORT) : 8787,
    model: env.RHUMBR_MODEL?.trim() || "claude-opus-4-8",
    workspace: env.RHUMBR_WORKSPACE?.trim() || "./workspace",
    oauthToken,
  };
}
