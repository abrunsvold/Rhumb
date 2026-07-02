import type { InfraConfig } from "../infra/types.js";
import type { LxcClient, LxcSpec } from "./types.js";

export function createLxcClient(cfg: NonNullable<InfraConfig["proxmox"]>): LxcClient {
  const base = `${cfg.baseUrl.replace(/\/$/, "")}/api2/json`;
  const authHeader = `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`;
  const node = cfg.node;

  async function call(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const encoded = body
      ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString()
      : undefined;
    const headers: Record<string, string> = { Authorization: authHeader };
    if (encoded !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const res = await fetch(`${base}${path}`, { method, headers, body: encoded });
    if (!res.ok) throw new Error(`proxmox-lxc ${method} ${path}: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { data: unknown }).data;
  }

  return {
    async create(spec: LxcSpec): Promise<{ id: number }> {
      const next = (await call("GET", "/cluster/nextid")) as number;
      const body: Record<string, unknown> = {
        vmid: next,
        ostemplate: spec.ostemplate,
        hostname: spec.name,
        cores: spec.cores,
        memory: spec.memory,
        rootfs: `${spec.storage}:${spec.rootfsGb}`,
        net0: `name=eth0,bridge=${spec.bridge},ip=dhcp`,
        "ssh-public-keys": spec.sshPublicKey,
        unprivileged: 1,
        onboot: 1,
        start: 0,
      };
      // PVE's own injected resolver can be unusable inside the container (e.g. a
      // Tailscale-connected host hands out MagicDNS, but the container has no
      // tailscaled) — that hangs apt/npm indefinitely. Pin a working nameserver.
      if (spec.nameserver) body.nameserver = spec.nameserver;
      await call("POST", `/nodes/${node}/lxc`, body);
      return { id: Number(next) };
    },
    async start(id) { await call("POST", `/nodes/${node}/lxc/${id}/status/start`); },
    async stop(id) { await call("POST", `/nodes/${node}/lxc/${id}/status/stop`); },
    async destroy(id) { await call("DELETE", `/nodes/${node}/lxc/${id}`); },
    async status(id) {
      const d = (await call("GET", `/nodes/${node}/lxc/${id}/status/current`)) as { status: string };
      return { id, status: d.status };
    },
    async ip(id): Promise<string | null> {
      // Right after start, the container has no IP yet and PVE returns data:null
      // for /interfaces. Treat any non-array response as "not ready" so the
      // caller's poll retries rather than crashing.
      const ifaces = (await call("GET", `/nodes/${node}/lxc/${id}/interfaces`)) as
        | Array<{ name: string; inet?: string }>
        | null;
      if (!Array.isArray(ifaces)) return null;
      const eth = ifaces.find((i) => i.name === "eth0" && i.inet) ?? ifaces.find((i) => i.inet && i.name !== "lo");
      if (!eth?.inet) return null;
      return eth.inet.split("/")[0]; // strip CIDR suffix
    },
  };
}
