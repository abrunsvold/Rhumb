export interface Config {
  port: number;
  model: string;
  workspace: string;
  oauthToken: string;
  permissionMode: string;
  controlToken?: string;
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
        "(uses your Claude subscription). Rhumb does not use ANTHROPIC_API_KEY.",
    );
  }
  let port = 8787;
  if (env.RHUMB_PORT) {
    const parsed = Number.parseInt(env.RHUMB_PORT, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(
        `RHUMB_PORT must be a number, got "${env.RHUMB_PORT}"`,
      );
    }
    port = parsed;
  }

  let permissionMode = "acceptEdits";
  if (env.RHUMB_PERMISSION_MODE) {
    const value = env.RHUMB_PERMISSION_MODE.trim();
    if (!VALID_PERMISSION_MODES.has(value)) {
      throw new Error(
        `RHUMB_PERMISSION_MODE must be one of default|acceptEdits|bypassPermissions|plan, got "${value}"`,
      );
    }
    permissionMode = value;
  }

  return {
    port,
    model: env.RHUMB_MODEL?.trim() || "claude-opus-4-8",
    workspace: env.RHUMB_WORKSPACE?.trim() || "./workspace",
    oauthToken,
    permissionMode,
    controlToken: env.RHUMB_CONTROL_TOKEN?.trim() || undefined,
  };
}
