export interface InfraConfig {
  auditPath: string;
  dataSourcesPath: string;
  proxmox?: { baseUrl: string; tokenId: string; tokenSecret: string; node: string };
  pgAdmin?: { connectionString: string };
}

export interface Vm { id: number; name: string; status: string }
export interface VmStatus { id: number; status: string; cpus?: number; maxmem?: number }

export interface ProxmoxClient {
  listVms(): Promise<Vm[]>;
  status(id: number): Promise<VmStatus>;
  create(spec: { name: string; cores: number; memory: number }): Promise<{ id: number }>;
  start(id: number): Promise<void>;
  stop(id: number): Promise<void>;
  resize(id: number, spec: { cores?: number; memory?: number }): Promise<void>;
  destroy(id: number): Promise<void>;
}

export interface AdminExecutor {
  exec(sql: string): Promise<void>;
}

export interface DataSourceEntry {
  id: string;
  type: "postgres";
  mode: "read" | "read-write";
  connectionString: string;
}

export type GatedTool =
  | "create_vm" | "start_vm" | "stop_vm" | "resize_vm" | "destroy_vm" | "provision_database"
  | "spawn_service" | "stop_service" | "start_service" | "destroy_service" | "redeploy_service";

export interface PendingAction {
  pendingId: string;
  tool: GatedTool;
  input: Record<string, unknown>;
  createdAt: string;
}

export interface InfraAuditEntry {
  ts: string;
  tool: string;
  input: Record<string, unknown>;
  decision: "approved" | "denied" | "error";
  result?: unknown;
  error?: string;
}
