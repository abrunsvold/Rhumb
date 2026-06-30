export interface Config {
  port: number;
  model: string;
  workspace: string;
  oauthToken: string;
  permissionMode: string;
}

const VALID_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!oauthToken) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN is required. Generate one with `claude setup-token` " +
        "(uses your Claude subscription). RHUMBR does not use ANTHROPIC_API_KEY.",
    );
  }
  let port = 8787;
  if (env.RHUMBR_PORT) {
    const parsed = Number.parseInt(env.RHUMBR_PORT, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(
        `RHUMBR_PORT must be a number, got "${env.RHUMBR_PORT}"`,
      );
    }
    port = parsed;
  }

  let permissionMode = "acceptEdits";
  if (env.RHUMBR_PERMISSION_MODE) {
    const value = env.RHUMBR_PERMISSION_MODE.trim();
    if (!VALID_PERMISSION_MODES.has(value)) {
      throw new Error(
        `RHUMBR_PERMISSION_MODE must be one of default|acceptEdits|bypassPermissions|plan, got "${value}"`,
      );
    }
    permissionMode = value;
  }

  return {
    port,
    model: env.RHUMBR_MODEL?.trim() || "claude-opus-4-8",
    workspace: env.RHUMBR_WORKSPACE?.trim() || "./workspace",
    oauthToken,
    permissionMode,
  };
}
