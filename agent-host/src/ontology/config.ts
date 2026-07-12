import type { OntologyConfig } from "./types.js";

export function loadOntologyConfig(env: NodeJS.ProcessEnv): OntologyConfig {
  const workspace = env.RHUMB_WORKSPACE?.trim() || "./workspace";
  const vaultPath = env.RHUMB_ONTOLOGY?.trim() || `${workspace}/ontology`;
  return {
    vaultPath,
    systemDir: `${vaultPath}/system`,
    domainDir: `${vaultPath}/domain`,
    dataSourcesPath: env.RHUMB_DATA_SOURCES?.trim() || `${workspace}/data-sources.json`,
    servicesPath: env.RHUMB_SERVICES?.trim() || `${workspace}/services.json`,
    surfacesDir: `${workspace}/surfaces`,
    dataAuditPath: env.RHUMB_DATA_AUDIT?.trim() || `${workspace}/data-audit.jsonl`,
    infraAuditPath: env.RHUMB_INFRA_AUDIT?.trim() || `${workspace}/infra-audit.jsonl`,
    nodeFactsPath: `${workspace}/node-facts.json`,
    ddlFactsPath: `${workspace}/ddl-facts.json`,
  };
}
