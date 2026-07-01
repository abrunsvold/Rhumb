export interface ServiceConfig {
  deployKeyPath: string;            // RHUMB_DEPLOY_KEY (private key, host-only)
  deployPublicKey: string;          // contents of RHUMB_DEPLOY_PUBKEY or <deployKeyPath>.pub
  ostemplate: string;               // e.g. "local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst"
  storage: string;                  // e.g. "local-lvm"
  bridge: string;                   // e.g. "vmbr0"
  rootfsGb: number;                 // e.g. 8
  servicesPath: string;             // <workspace>/services.json
  workspace: string;                // <workspace> (service dirs live at <workspace>/services/<id>)
}

export interface LxcSpec {
  name: string;
  cores: number;
  memory: number;
  ostemplate: string;
  storage: string;
  bridge: string;
  rootfsGb: number;
  sshPublicKey: string;
}

export interface LxcClient {
  create(spec: LxcSpec): Promise<{ id: number }>;
  start(id: number): Promise<void>;
  stop(id: number): Promise<void>;
  destroy(id: number): Promise<void>;
  status(id: number): Promise<{ id: number; status: string }>;
  ip(id: number): Promise<string | null>;
}

export interface SshTarget { host: string; user: string; privateKeyPath: string }

export interface SshExec {
  run(target: SshTarget, command: string): Promise<{ stdout: string; stderr: string }>;
  pushDir(target: SshTarget, localDir: string, remoteDir: string): Promise<void>;
}

export interface ServiceManifest {
  id: string;
  type: "service";
  name: string;
  start: string;
  port: number;
  resources?: { cores?: number; memory?: number };
}

export interface ServiceDeployer {
  deploy(target: SshTarget, localDir: string, manifest: ServiceManifest): Promise<void>;
}

export interface ServiceEntry {
  id: string;
  name: string;
  containerId: number;
  host: string;
  port: number;
  basePath: string;                 // /services/<id>
  status: "healthy" | "unhealthy" | "starting";
  createdAt: string;
}

export type GatedServiceTool = "spawn_service" | "stop_service" | "start_service" | "destroy_service";
