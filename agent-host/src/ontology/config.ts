import type { OntologyConfig } from "./types.js";

export function loadOntologyConfig(env: NodeJS.ProcessEnv): OntologyConfig {
  const workspace = env.RHUMBR_WORKSPACE?.trim() || "./workspace";
  const vaultPath = env.RHUMBR_ONTOLOGY?.trim() || `${workspace}/ontology`;
  return {
    vaultPath,
    systemDir: `${vaultPath}/system`,
    domainDir: `${vaultPath}/domain`,
    dataSourcesPath: env.RHUMBR_DATA_SOURCES?.trim() || `${workspace}/data-sources.json`,
    servicesPath: env.RHUMBR_SERVICES?.trim() || `${workspace}/services.json`,
    surfacesDir: `${workspace}/surfaces`,
    dataAuditPath: env.RHUMBR_DATA_AUDIT?.trim() || `${workspace}/data-audit.jsonl`,
    infraAuditPath: env.RHUMBR_INFRA_AUDIT?.trim() || `${workspace}/infra-audit.jsonl`,
  };
}
