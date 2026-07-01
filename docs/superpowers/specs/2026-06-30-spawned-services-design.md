# Rhumb Spawned Services Design Spec (Plan 6 of 7)

**Date:** 2026-06-30
**Status:** Approved design (sub-spec of the Rhumb master spec §3.2 service router + §3.4 spawned services).
**Depends on:** the agent host + infra capability (Plans 1, 5), the dashboard host + registry (Plan 2), the data endpoint (Plan 4), and the client confirmation surface (Plans 4–5).

Grounded against the master spec: a `service` surface is "a dashboard whose runtime is a Proxmox container the agent provisioned," registered through the dashboard host's reverse proxy so a running app looks identical to a served file from the client's side.

---

## 1. Role

This plan lets the agent **materialize a `service` surface**: a full app running in its **own Proxmox LXC**, reachable at a stable dashboard-host URL and rendered by the client **identically to a `file` surface**. It **reuses Plan 5 wholesale** — the scoped Proxmox API token, the `canUseTool` gating + pending-action queue, the infra audit log, and the already-generalized client confirmation dialog. The new machinery is deliberately small: LXC lifecycle, an SSH-based code deploy, a service manifest, a spawn orchestrator, and the dashboard host's reverse proxy + service registry + liveness probe.

**Container = blast-radius boundary.** Arbitrary long-running code is allowed, but only inside its LXC; the scoped token, audit log, and operator confirmations still apply. **Raw processes on the host are not permitted** — every service is containerized.

## 2. Architecture

- **Agent host** owns the new gated tools (`spawn_service`, `stop_service`, `start_service`, `destroy_service`) plus read tools (`list_services`, `service_status`), the LXC client, the SSH deployer, and the spawn orchestrator. Destructive/provisioning tools gate through the **same** Plan-5 `canUseTool` → pending-action queue → operator confirmation → audit path.
- **Dashboard host** re-reads a service registry file, reverse-proxies `/services/:id/*` to the running container, runs a liveness probe, and surfaces `kind:"service"` entries in the existing registry so the client renders them like `file` surfaces.
- **Client** needs **no new work**: service surfaces are registry URLs the existing surface machinery renders, and gated service actions flow through Plan 5's already-generalized confirmation dialog (`origin:"infra"`).

### 2.1 LXC client (seam)

Plan 5's `ProxmoxClient` targets QEMU VMs (`/nodes/{node}/qemu`). Containers use `/nodes/{node}/lxc`. This plan adds an **`LxcClient`** interface (a sibling seam, same scoped token and auth-header format):

```ts
interface LxcClient {
  create(spec: LxcSpec): Promise<{ id: number }>;
  start(id: number): Promise<void>;
  stop(id: number): Promise<void>;
  destroy(id: number): Promise<void>;
  status(id: number): Promise<{ id: number; status: string }>;
  ip(id: number): Promise<string | null>;   // from the container's network interfaces
}
```

`LxcSpec` includes: `ostemplate` (a stock Ubuntu template on the operator's storage), `storage`, `cores`, `memory`, `net` (dhcp on the operator's bridge), `sshPublicKeys` (Rhumb's **deploy public key**), `onboot: 1`, `unprivileged: 1`, optional `features` (e.g. `nesting`). The real implementation calls the PVE LXC REST API; the tool handlers depend only on the interface, so they are unit-tested with a fake. The real path is **build-verified + live-verified**.

Proxmox's `VM.*` privileges apply to **both** QEMU VMs and LXC containers, but the **Plan-6 live run found the Plan-5 token role needed two more privileges** to create a *networked* LXC (Plan 5's VM-create test used no network config, so it never hit them): **`VM.Config.Network`** (to attach `net0`) and, on **PVE 9's SDN layer, `SDN.Use`** on the bridge's zone (to use `vmbr0`). So the operator's scoped role must include, beyond the Plan-5 set: **`VM.Config.Network`, `VM.Config.Cloudinit`, `SDN.Use`** (plus the existing `VM.Allocate`, `VM.Config.CPU/Memory/Disk/Options`, `VM.PowerMgmt`, `VM.Audit`, `VM.Console`, `Datastore.AllocateSpace/Audit`, `Sys.Audit`). Called out in config docs.

### 2.2 SSH deployer (seam)

Rhumb holds only the scoped **API token** — the PVE REST API exposes no container exec/file-push — so code is deployed **over SSH** to the container's own IP:

```ts
interface ServiceDeployer {
  deploy(target: { host: string; user: string; privateKeyPath: string }, bundlePath: string, manifest: ServiceManifest): Promise<void>;
}
```

The real implementation: `scp` the agent's code bundle into the container, write a **`Restart=always` systemd unit** that runs the manifest `start` command in the app's working directory with injected env — `PORT=<manifest.port>` and `RHUMB_SERVICE_BASE=/services/<id>` — then `systemctl enable --now`. It is built on an **injectable ssh-exec seam** (a thin `run(cmd)` / `push(localPath, remotePath)` interface) so the deployer's logic — the exact scp target, the systemd unit contents, the enable command, the injected env — is unit-tested with a fake; the real SSH path is live-verified.

The LXC is created with Rhumb's deploy **public** key; the **private key stays on the agent host** (host-only, stripped from the spawned agent subprocess env like other secrets), path from config.

### 2.3 Service manifest

The agent writes, into `<workspace>/services/<id>/`:
- the app code, and
- `service.json`: `{ id, type:"service", name, start, port, resources?: { cores?, memory? }, createdAt }`.

`id` is URL-safe (`^[A-Za-z0-9._-]+$`); `start` is the in-container command; `port` is the port the app listens on inside the container. Manifest validation is a pure, unit-tested function; a malformed manifest fails the spawn with a clear message (never a partial container).

### 2.4 Spawn orchestrator

The `spawn_service` handler ties the seams together:
1. Validate the manifest.
2. `LxcClient.create` (deploy pubkey, `onboot=1`) → `start` → poll `ip()` until the container has an address (bounded timeout).
3. `ServiceDeployer.deploy` (scp bundle + install & enable the systemd unit with `PORT`/base-path env).
4. Append the running service to the **service registry** (§2.5) and return the stable URL `/services/<id>/`.

**Failure at any step → best-effort rollback** (destroy the half-created container), an `isError` tool result with a sanitized message, and an **error** audit line. No dangling containers, no half-registered services. The orchestrator depends only on the seams + a clock/id, so it is unit-tested (happy path + rollback-on-failure) with fakes.

### 2.5 Dashboard-host reverse proxy + service registry

- **Service registry:** `<workspace>/services.json`, a list of `{ id, name, containerId, host, port, basePath, status, createdAt }`, **re-read per request** (same discipline as Plan 4/7 data sources), so a freshly-spawned service appears without a restart.
- **Reverse proxy:** the dashboard host mounts `/services/:id/*` → `http://<host>:<port>/*` for the matching registry entry (Node http proxy / `http-proxy`, with **WebSocket upgrade** support). Unknown/absent id → 404; a service whose target is down → **502**.
- **Registry integration:** service entries also appear in the existing surface registry as `kind:"service"` with `url: /services/<id>/`, so the client renders them identically to `file` surfaces (no client change).
- **Liveness probe:** a periodic check hits each service's proxy target and sets its `status` in `services.json` (`healthy` / `unhealthy`), surfaced in the registry. The probe interval + timeout are config; the probe logic (target → status transition) is a pure, unit-tested function behind a fake prober.

### 2.6 Gated tools (reuse Plan 5)

New tools registered in the Plan-5 infra MCP server:
| Tool | Gating | Action |
| --- | --- | --- |
| `list_services` | allowlisted (read) | list services + status |
| `service_status` | allowlisted (read) | one service's status |
| `spawn_service` | gated | provision LXC + deploy + register |
| `stop_service` | gated | stop the container |
| `start_service` | gated | start the container |
| `destroy_service` | gated | stop + destroy + deregister |

Gated tools are omitted from `allowedTools` → routed through Plan 5's `canUseTool` + pending-action queue + client confirmation + infra audit. The read tools are allowlisted (`mcp__infra__list_services`, `mcp__infra__service_status`).

## 3. Health / restart policy (v1)

Crash-restart and reboot-restore come from **systemd inside the container** (`Restart=always`) plus the LXC's **`onboot=1`** — not bespoke Rhumb code. Rhumb's contribution is the **liveness probe** that reflects real reachability into the registry status, and `destroy_service` which reaps everything. No Rhumb-side active-restart loop or dead-service GC sweep in v1 (deferred).

## 4. Data flow (spawn → render)

1. Agent writes app code + `service.json` into `<workspace>/services/<id>/`.
2. Agent calls gated `spawn_service` → `canUseTool` enqueues → operator confirms in the client (Plan 5 dialog, `origin:"infra"`).
3. Orchestrator: create LXC → start → await IP → deploy over SSH (systemd unit) → append to `services.json` + registry → audit → return `/services/<id>/`.
4. Dashboard host (re-reading `services.json`) reverse-proxies `/services/<id>/*` → container:port; the client's registry shows the service surface; opening it proxies to the live app.
5. The liveness probe updates status; `destroy_service` stops + destroys the LXC and removes the registry entry (confirmed + audited).

## 5. Security / scoping

- **Same scoped PVE token**, now also authorized for **LXC** ops (least-privilege CT lifecycle + datastore, not root). Blast radius bounded by the token.
- **Container = boundary.** Arbitrary code only inside the LXC; **no raw host processes**.
- **Deploy SSH private key is host-only** (config path), stripped from the spawned agent subprocess env like every other `RHUMB_*` secret (Plan-5 fix); the container gets only the public key.
- Reverse proxy is the single choke point; containers aren't exposed directly to the client.
- Every gated/destructive service op requires **interactive operator confirmation** + an **audit** line.
- PVE calls inherit the Plan-5 self-signed-TLS handling (the pending CA-cert/scoped-insecure follow-up applies here too).

## 6. Error handling

- Spawn-step failure → best-effort rollback (destroy half-created container) + `isError` + error audit; no dangling containers.
- Proxy target down / no registry entry → **502** / **404** from the proxy; status `unhealthy` in the registry via the probe.
- SSH/boot/deploy timeout → fail the spawn with a sanitized message; roll back.
- A denied gated action → clear denial to the model + audit line; no infra change.
- **Slow spinup is accepted** (fast-spinup deferred): a spawn installs deps in-container and may take minutes; the tool returns when healthy or times out.

## 7. Testing & verification

- **Unit (agent host):** `LxcClient` (fake fetch → correct LXC API paths/bodies/auth), `ServiceDeployer` (fake ssh-exec → correct scp target + systemd unit contents + injected `PORT`/base-path env + enable), the spawn orchestrator (happy path + rollback-on-failure with fakes), manifest validation, the new gated tools via the Plan-5 gating harness, and the infra audit lines.
- **Unit (dashboard host):** `services.json` append/read (post-startup addition found), the `/services/:id/*` reverse-proxy route (Supertest + a fake upstream: proxies through, 404 unknown id, 502 when target down), and the liveness-probe status transition (fake prober).
- **Unit (client):** none required (service surfaces reuse the registry/surface machinery; gated service actions reuse the Plan-5 confirmation reducer/dialog). A small assertion that a `kind:"service"` registry entry renders like a file surface, if cheap.
- **Live run (driver, against the operator's Proxmox):** the agent spawns a tiny HTTP app → confirmation → approve → an LXC appears, the app deploys and runs under systemd, `/services/<id>/` proxies to it and renders in the client; a crash auto-restarts (systemd); `stop`/`start`/`destroy` work; a **denied** `destroy_service` leaves the service running.

## 8. Scope / out of scope

- **In:** the LXC client; the SSH deployer; the service manifest + validation; the spawn orchestrator + the four gated tools + two read tools (reusing Plan 5 gating/audit/pending/confirmation); the dashboard-host reverse proxy + service registry (re-read per request) + liveness probe; registry integration so service surfaces render like file surfaces; config for the deploy key + LXC template/storage/bridge.
- **Out (later plans / deferred):** fast/idempotent spinup + prebaked per-stack templates; multi-node placement; Docker/build-based packaging; autoscaling; per-service resource dashboards / log-streaming UI; Rhumb-side active-restart orchestration + dead-service GC; the ontology (Plan 7 records what this plan spawns).

## 9. Implementation phases (one plan)

1. **Agent-host service core:** config (deploy key, template/storage/bridge); the `LxcClient` seam + real implementation; the SSH deployer seam + real implementation; manifest validation; the spawn orchestrator (with rollback); the service registry writer; the new gated + read tools wired into the Plan-5 infra MCP server + gating.
2. **Dashboard-host integration:** the service registry reader (re-read per request); the `/services/:id/*` reverse proxy (with WS upgrade); the liveness probe; registry integration for `kind:"service"`.

The live run (Proxmox + a spawned app) verifies both phases end-to-end.
