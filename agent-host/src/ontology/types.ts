export interface Relationship { edge: string; target: string }

export interface OntologyNode {
  type: string;                       // datasource | service | container | vm | dashboard | entity
  id: string;                         // prefixed, e.g. "service-demo-svc"
  title: string;
  managed: "system" | "domain";
  created?: string;
  updated?: string;
  props: Record<string, string>;      // extra frontmatter keys
  relationships: Relationship[];
}

export interface OntologyConfig {
  vaultPath: string;                  // <workspace>/ontology
  systemDir: string;                  // <vault>/system
  domainDir: string;                  // <vault>/domain
  dataSourcesPath: string;
  servicesPath: string;
  surfacesDir: string;                // <workspace>/surfaces
  dataAuditPath: string;
  infraAuditPath: string;
  nodeFactsPath: string;
}
