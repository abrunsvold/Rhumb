export interface Config {
  port: number;
  workspace: string;
  dataSourcesPath: string;
  dataTrustPath: string;
  dataAuditPath: string;
  servicesPath: string;
  controlToken?: string;
  appOrigins: string[];
  allowedUsers: string[];
  insecureDev: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  let port = 8788;
  if (env.RHUMB_DASHBOARD_PORT) {
    const parsed = Number.parseInt(env.RHUMB_DASHBOARD_PORT, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(
        `RHUMB_DASHBOARD_PORT must be a number, got "${env.RHUMB_DASHBOARD_PORT}"`,
      );
    }
    port = parsed;
  }
  const workspace = env.RHUMB_WORKSPACE?.trim() || "./workspace";

  const insecureDev = env.RHUMB_INSECURE_DEV === "1";
  const allowedUsers = (env.RHUMB_ALLOWED_USERS ?? "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  if (!insecureDev && allowedUsers.length === 0) {
    throw new Error(
      "RHUMB_ALLOWED_USERS is required (comma-separated tailnet logins). Rhumb " +
        "fails closed: every request must carry an allowlisted Tailscale identity. " +
        "Set RHUMB_INSECURE_DEV=1 only for local development without tailscale serve.",
    );
  }

  return {
    port,
    workspace,
    dataSourcesPath: env.RHUMB_DATA_SOURCES?.trim() || `${workspace}/data-sources.json`,
    dataTrustPath: env.RHUMB_DATA_TRUST?.trim() || `${workspace}/data-trust.json`,
    dataAuditPath: env.RHUMB_DATA_AUDIT?.trim() || `${workspace}/data-audit.jsonl`,
    servicesPath: env.RHUMB_SERVICES?.trim() || `${workspace}/services.json`,
    controlToken: env.RHUMB_CONTROL_TOKEN?.trim() || undefined,
    appOrigins: (env.RHUMB_APP_ORIGINS?.trim()
      ? env.RHUMB_APP_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
      : ["tauri://localhost", "https://tauri.localhost"]),
    allowedUsers,
    insecureDev,
  };
}
