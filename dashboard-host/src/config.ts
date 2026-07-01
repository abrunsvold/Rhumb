export interface Config {
  port: number;
  workspace: string;
  dataSourcesPath: string;
  dataTrustPath: string;
  dataAuditPath: string;
  servicesPath: string;
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
  const workspace = env.RHUMBR_WORKSPACE?.trim() || "./workspace";
  return {
    port,
    workspace,
    dataSourcesPath: env.RHUMBR_DATA_SOURCES?.trim() || `${workspace}/data-sources.json`,
    dataTrustPath: env.RHUMBR_DATA_TRUST?.trim() || `${workspace}/data-trust.json`,
    dataAuditPath: env.RHUMBR_DATA_AUDIT?.trim() || `${workspace}/data-audit.jsonl`,
    servicesPath: env.RHUMBR_SERVICES?.trim() || `${workspace}/services.json`,
  };
}
