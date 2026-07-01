# Rhumb Infrastructure Capability Design Spec (Plan 5 of 7)

**Date:** 2026-06-30
**Status:** Approved design (sub-spec of the Rhumb master spec §3.4).
**Depends on:** the agent host (Plan 1), dashboard host + data endpoint (Plans 2, 4), and the client confirmation surface (Plan 4).

Grounded against live Claude Agent SDK docs: in-process custom tools (`createSdkMcpServer` + `tool`) and the permission flow (`canUseTool` gates any tool not in `allowedTools`).

---

## 1. Role

This plan gives the agent **tools to operate the operator's infrastructure** — full Proxmox VM lifecycle and PostgreSQL database provisioning — with **every destructive/provisioning call gated behind an operator confirmation in the desktop client** and an audit trail. A provisioned database **auto-registers as a Plan-4 data source**, closing the "agent creates a DB → wires a dashboard to it" loop.

## 2. Architecture

- **Agent host** owns the tools, the credentials (scoped Proxmox API token; PG admin connection), the gating, and the audit log. The tools run **in-process** in the agent host via the Agent SDK's in-process MCP server.
- **Client** confirms gated actions. The Plan-4 confirmation surface generalizes to handle **two** pending streams: dashboard data-writes and agent infra-actions.
- **Dashboard host** re-reads `data-sources.json` so a freshly-provisioned DB appears without a restart.

### 2.1 The infra MCP server (agent host)

An in-process server `infra` (`createSdkMcpServer`) wired into the agent host's `query` via `options.mcpServers = { infra: infraServer }`. Tools, each `tool(name, description, zodSchema, handler)`:

| Tool | Gating | Action |
| --- | --- | --- |
| `list_vms` | allowlisted (read) | list VMs/containers + status |
| `vm_status` | allowlisted (read) | one VM's status/config |
| `create_vm` | gated | create/clone a VM or container |
| `start_vm` | gated | start |
| `stop_vm` | gated | stop |
| `resize_vm` | gated | change CPU/RAM/disk |
| `destroy_vm` | gated | delete |
| `provision_database` | gated | create a Postgres DB + role, auto-register as a data source |

Read tools go in `allowedTools` (`mcp__infra__list_vms`, `mcp__infra__vm_status`) and run without confirmation. Gated tools are **deliberately omitted** from `allowedTools`; with `permissionMode: "default"` they fall through to `canUseTool`.

### 2.2 Gating via `canUseTool` + the pending-action queue

The agent host passes a `canUseTool` callback to `query`. When a gated infra tool is called:
1. The callback **enqueues a pending infra-action** `{ pendingId, tool, input, createdAt }` and returns a Promise it awaits.
2. The agent host exposes the queue over HTTP (mirroring Plan 4's pending-write surface, but on the agent host): `GET /infra/pending`, `GET /infra/pending/stream` (SSE), `POST /infra/pending/:id/resolve { decision }`.
3. The client subscribes to the stream, shows a confirmation dialog, and POSTs the decision.
4. The callback's Promise resolves: **approve → return allow** (the SDK then runs the tool handler) / **deny → return deny** (the model sees a denial). Either way an audit line is appended.

> The exact `canUseTool` return shape (e.g. `{ behavior: "allow", updatedInput } | { behavior: "deny", message }`) and signature are grounded from the Agent SDK `user-input` reference when the plan is written; the mechanism (non-allowlisted tools route to `canUseTool`, which returns allow/deny) is fixed.

**Auto-trust:** unlike Plan 4 data-writes, infra actions have **no "trust this" toggle** — every gated infra call is confirmed individually (destroy-class operations are too consequential to auto-approve).

### 2.3 Proxmox client (seam)

`interface ProxmoxClient { listVms(): Promise<Vm[]>; status(id): Promise<VmStatus>; create(spec): Promise<...>; start(id); stop(id); resize(id, spec); destroy(id) }`. The real implementation calls the **Proxmox VE REST API** (`https://<host>:8006/api2/json/...`) with a **scoped API token** (`Authorization: PVEAPIToken=user@realm!tokenid=secret`). The tool handlers depend only on the interface, so they are unit-tested with a fake client; the real Proxmox path is live-verified.

### 2.4 DB provisioner (seam) + auto-register

`provision_database({ name })`:
1. Connects to an operator-declared **PG admin connection** (config) and runs `CREATE DATABASE` + `CREATE ROLE` (parameterized identifiers validated, same allowlist discipline as Plan 4's `buildSql`).
2. **Writes a new source entry** into the dashboard host's `data-sources.json` (shared workspace path): `{ id, type:"postgres", mode:"read-write", connectionString }` for the new DB.
3. Returns the new source id to the agent.

The PG-admin execution is behind an injectable seam (fake in tests; real `pg` in the live run). The `data-sources.json` append helper is pure/testable.

### 2.5 Infra audit log

Append-only JSONL on the agent host (`RHUMB_INFRA_AUDIT`, default `<workspace>/infra-audit.jsonl`): one line per gated action — `{ ts, tool, input, decision:"approved"|"denied", result?, error? }`. Read tools are not audited.

## 3. Client (generalized confirmation surface)

- The Rust proxy gains `start_infra_pending_stream` / `stop_infra_pending_stream` / `resolve_infra_pending` commands (point at the **agent** base, mirroring Plan 4's data-pending commands against the dashboard base).
- The confirmation UI generalizes: a single dialog renders the **next pending item from either source** — a data-write (source + structured op + trust toggle) or an infra-action (tool + input, approve/deny only). A shared `pendingStore`-style reducer merges both streams; items carry an `origin: "data" | "infra"` discriminator so the dialog routes the resolve to the right endpoint.
- App subscribes to both pending streams (dashboard data + agent infra) on connect.

## 4. Dashboard host change (source reload)

`/data` routes currently read `loadDataSources` once in `buildApp`. Change so the declared sources are **re-read per request** (or the file is watched), so a DB the agent provisions appears immediately. Small, isolated change to the data layer; covered by a test that a source added to `data-sources.json` after startup is found.

## 5. Data flow

1. The agent decides to provision a DB or change a VM → calls a gated `infra` tool.
2. `canUseTool` enqueues a pending infra-action → the client's confirmation dialog pops (tool + input) → operator approves.
3. The callback returns `allow` → the SDK runs the handler → the Proxmox client / DB provisioner executes → audit line appended.
4. For `provision_database`: the new source is written to `data-sources.json`; the dashboard host (re-reading sources) now serves `/data/:newSource/*`; a surface can read/write it (Plan 4).

## 6. Security / scoping

- The Proxmox **API token is scoped** (a dedicated, least-privilege token, not root) — blast radius is bounded by the token's privileges.
- Every gated/destructive action requires **interactive operator confirmation**; no auto-trust for infra.
- All gated actions are **audited**.
- Credentials (Proxmox token, PG admin) live only on the agent host (alongside the Claude subscription token); never sent to the client (the client only sees the pending action's tool+input for display).
- Identifier inputs to SQL (`provision_database`) are allowlist-validated and quoted; connection details are server-side.

## 7. Error handling

- A tool handler catches failures and returns `isError: true` (so the agent loop continues and the model can react) rather than throwing (which would abort the query).
- A denied action returns a clear denial to the model + an audit line; no infra change.
- A Proxmox/PG error → `isError: true` result with a sanitized message + an `error` audit line.
- A dropped infra-pending stream is retried by the Rust side with backoff; the client re-lists `/infra/pending` on reconnect.
- `provision_database` is **not** transactional across systems: if the DB is created but the `data-sources.json` write fails, the audit records the partial state and the tool returns an error naming the created DB so the operator can reconcile.

## 8. Testing & verification

- **Unit (agent host):** the gating/pending-action queue (enqueue → resolve approve/deny → the awaited Promise resolves correctly), with a fake clock/id; each tool handler against a **fake `ProxmoxClient`** and a **fake PG-admin executor** (correct API calls, `isError` on failure, audit lines); the `data-sources.json` append/auto-register helper; the SQL identifier validation for `provision_database`.
- **Unit (dashboard host):** sources re-read finds a post-startup-added source.
- **Unit (client):** the merged pending reducer (data + infra items, `origin` routing).
- **Rust/glue:** the infra-pending commands are build-verified (the Channel/pump pattern is already tested).
- **Live run (driver, against your Proxmox):** the agent provisions a DB → confirmation dialog → approve → the DB exists in Postgres + a `data-sources.json` entry appears + a surface reads/writes it (this also completes Plan 4's live verification). The agent creates and then destroys a small VM → each pops a confirmation → approve → the VM appears/disappears in Proxmox + audit lines. A denied destroy leaves the VM intact.

## 9. Scope / out of scope

- **In:** the infra MCP server (read + gated tools); `canUseTool` gating + the pending-infra-action queue/stream/resolve; the Proxmox client (full VM lifecycle: list/status/create/start/stop/resize/destroy); the DB provisioner + auto-register; the infra audit log; config for the scoped Proxmox token + PG admin; the client's generalized confirmation surface; the dashboard-host source reload.
- **Out (later plans):** spawned container-isolated `service` surfaces (Plan 6 — distinct from VM lifecycle); the ontology that records what's created (Plan 7 — this plan produces the audit/records it will consume); fast/idempotent provisioning; multi-node Proxmox orchestration; non-Postgres database engines.

## 10. Implementation phases (one plan)

1. **Agent-host infra core:** config; the Proxmox client seam + a real implementation; the DB provisioner seam + auto-register helper; the infra audit log; the pending-action queue; the `canUseTool` gating wiring; the `infra` MCP server + tools; the `/infra/pending*` HTTP surface.
2. **Client + dashboard integration:** the dashboard-host source reload; the Rust infra-pending commands; the generalized client confirmation surface; wiring.

The live run (Proxmox + PG admin) verifies both phases — and Plan 4 — end-to-end.
