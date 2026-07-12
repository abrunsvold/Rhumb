import type { ProxmoxClient, InfraConfig, Vm, VmStatus } from "./types.js";

export type PveCall = (method: string, path: string, body?: Record<string, unknown>) => Promise<unknown>;

// Shared PVE request scaffolding — the VM client and the node-facts refresher
// both speak through this rather than each re-implementing auth/encoding.
export function createPveCall(cfg: NonNullable<InfraConfig["proxmox"]>): PveCall {
  const base = `${cfg.baseUrl.replace(/\/$/, "")}/api2/json`;
  const authHeader = `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`;

  return async function call(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    // Encode the body as form-urlencoded (Proxmox expects this for POSTs), coercing
    // numeric fields to strings explicitly. Only send Content-Type when there is a body.
    const encoded = body
      ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString()
      : undefined;
    const headers: Record<string, string> = { Authorization: authHeader };
    if (encoded !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const res = await fetch(`${base}${path}`, { method, headers, body: encoded });
    if (!res.ok) throw new Error(`proxmox ${method} ${path}: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { data: unknown }).data;
  };
}

// Real Proxmox VE API client. Auth via API token header. Endpoint paths follow the
// Proxmox VE API (qemu under /nodes/{node}/qemu). Live-verified against the operator's PVE.
export function createProxmoxClient(cfg: NonNullable<InfraConfig["proxmox"]>): ProxmoxClient {
  const call = createPveCall(cfg);
  const node = cfg.node;

  return {
    async listVms(): Promise<Vm[]> {
      const data = (await call("GET", `/nodes/${node}/qemu`)) as Array<{ vmid: number; name?: string; status: string }>;
      return data.map((v) => ({ id: v.vmid, name: v.name ?? String(v.vmid), status: v.status }));
    },
    async status(id: number): Promise<VmStatus> {
      const d = (await call("GET", `/nodes/${node}/qemu/${id}/status/current`)) as { status: string; cpus?: number; maxmem?: number };
      return { id, status: d.status, cpus: d.cpus, maxmem: d.maxmem };
    },
    async create(spec): Promise<{ id: number }> {
      // Allocate the next id, then create. Operators may prefer cloning a template;
      // adjust to your PVE setup during the live run.
      const next = (await call("GET", "/cluster/nextid")) as number;
      await call("POST", `/nodes/${node}/qemu`, { vmid: next, name: spec.name, cores: spec.cores, memory: spec.memory });
      return { id: Number(next) };
    },
    async start(id) { await call("POST", `/nodes/${node}/qemu/${id}/status/start`); },
    async stop(id) { await call("POST", `/nodes/${node}/qemu/${id}/status/stop`); },
    async resize(id, spec) { await call("POST", `/nodes/${node}/qemu/${id}/config`, { ...(spec.cores ? { cores: spec.cores } : {}), ...(spec.memory ? { memory: spec.memory } : {}) }); },
    async destroy(id) { await call("DELETE", `/nodes/${node}/qemu/${id}`); },
  };
}
