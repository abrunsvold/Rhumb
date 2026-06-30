import type { InfraConfig } from "./types.js";

export function loadInfraConfig(env: NodeJS.ProcessEnv): InfraConfig {
  const workspace = env.RHUMBR_WORKSPACE?.trim() || "./workspace";
  const cfg: InfraConfig = {
    auditPath: env.RHUMBR_INFRA_AUDIT?.trim() || `${workspace}/infra-audit.jsonl`,
    dataSourcesPath: env.RHUMBR_DATA_SOURCES?.trim() || `${workspace}/data-sources.json`,
  };
  const { RHUMBR_PROXMOX_URL, RHUMBR_PROXMOX_TOKEN_ID, RHUMBR_PROXMOX_TOKEN_SECRET, RHUMBR_PROXMOX_NODE } = env;
  if (RHUMBR_PROXMOX_URL && RHUMBR_PROXMOX_TOKEN_ID && RHUMBR_PROXMOX_TOKEN_SECRET && RHUMBR_PROXMOX_NODE) {
    cfg.proxmox = {
      baseUrl: RHUMBR_PROXMOX_URL.trim(),
      tokenId: RHUMBR_PROXMOX_TOKEN_ID.trim(),
      tokenSecret: RHUMBR_PROXMOX_TOKEN_SECRET.trim(),
      node: RHUMBR_PROXMOX_NODE.trim(),
    };
  }
  if (env.RHUMBR_PG_ADMIN?.trim()) cfg.pgAdmin = { connectionString: env.RHUMBR_PG_ADMIN.trim() };
  return cfg;
}
