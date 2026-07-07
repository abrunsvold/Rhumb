import type { InfraConfig } from "./types.js";

export function loadInfraConfig(env: NodeJS.ProcessEnv): InfraConfig {
  const workspace = env.RHUMB_WORKSPACE?.trim() || "./workspace";
  const cfg: InfraConfig = {
    auditPath: env.RHUMB_INFRA_AUDIT?.trim() || `${workspace}/infra-audit.jsonl`,
    dataSourcesPath: env.RHUMB_DATA_SOURCES?.trim() || `${workspace}/data-sources.json`,
  };
  const { RHUMB_PROXMOX_URL, RHUMB_PROXMOX_TOKEN_ID, RHUMB_PROXMOX_TOKEN_SECRET, RHUMB_PROXMOX_NODE } = env;
  if (RHUMB_PROXMOX_URL && RHUMB_PROXMOX_TOKEN_ID && RHUMB_PROXMOX_TOKEN_SECRET && RHUMB_PROXMOX_NODE) {
    cfg.proxmox = {
      baseUrl: RHUMB_PROXMOX_URL.trim(),
      tokenId: RHUMB_PROXMOX_TOKEN_ID.trim(),
      tokenSecret: RHUMB_PROXMOX_TOKEN_SECRET.trim(),
      node: RHUMB_PROXMOX_NODE.trim(),
    };
  }
  if (env.RHUMB_PG_ADMIN?.trim()) cfg.pgAdmin = { connectionString: env.RHUMB_PG_ADMIN.trim() };
  if (env.TS_API_KEY?.trim() && env.TS_TAILNET?.trim()) {
    cfg.tailscale = { apiKey: env.TS_API_KEY.trim(), tailnet: env.TS_TAILNET.trim() };
  }
  return cfg;
}
