export interface Config {
  port: number;
  workspace: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  let port = 8788;
  if (env.RHUMBR_DASHBOARD_PORT) {
    const parsed = Number.parseInt(env.RHUMBR_DASHBOARD_PORT, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(
        `RHUMBR_DASHBOARD_PORT must be a number, got "${env.RHUMBR_DASHBOARD_PORT}"`,
      );
    }
    port = parsed;
  }
  return {
    port,
    workspace: env.RHUMBR_WORKSPACE?.trim() || "./workspace",
  };
}
