# RHUMBR — Design Spec

**Date:** 2026-06-30
**Status:** Draft for review
**Scope:** v1 (MVP) with a clear path to deferred capabilities

---

## 1. Summary

RHUMBR is a self-hostable platform that turns **Claude Code** into a persistent,
interactive workspace running on your **own hardware** (a Proxmox host), reached
securely over a **Tailscale** mesh network.

The core insight: tools like OpenClaw trap a capable agent inside a linear chat
transcript. The agent underneath can build dashboards and live-data UIs — but you
never get to *keep* or *interact with* what it makes. RHUMBR lets the agent
**materialize durable, interactive surfaces** that run as real services on your
box and persist across sessions.

It is open-source and reusable: build it for yourself, but clean enough that
others can stand up their own.

### Differentiators
- **Use your existing Claude subscription.** Server-side Claude Code runs under
  its normal interactive login — not pay-per-token API billing.
- **Outputs are durable, not disposable.** The agent builds dashboards/apps that
  stay running and reachable.
- **Runs on your own compute, your own data.** Nothing lives in a hosted SaaS.
- **The agent operates your infrastructure** — it can manage VMs and provision
  databases to support complex work, not just read data.
- **The agent can build full applications, not just static dashboards** — it can
  spawn complete backend services (any stack), each isolated in its own
  Proxmox-managed container.
- **A persistent ontology** gives the agent (and you) a coherent, browsable model
  of both your environment and your domain data.

---

## 2. Architecture overview

Two sides, joined over Tailscale:

```
  Laptop (Tauri client)                 Proxmox host (server)
  ┌─────────────────────┐    Tailscale   ┌──────────────────────────────┐
  │ Agent panel (chat)  │◄──────────────►│ Agent host (Claude Code)     │
  │ Canvas (dashboards) │                │ Dashboard host (+ registry)  │
  │ Connection layer    │                │ Data endpoint (read/write)   │
  └─────────────────────┘                │ Infra capability (Proxmox/DB)│
                                         │ Ontology (markdown graph)    │
                                         │ Audit log                    │
                                         │ Workspace folder             │
                                         └──────────────────────────────┘
```

**Principle:** everything durable — the agent, your data, the apps it builds, the
ontology — lives **server-side**. The Tauri client is a rich remote window. Heavy
lifting and your Claude subscription stay on the box where the compute is.

---

## 3. Components

### Server (Proxmox host)

**3.1 Agent host**
Runs Claude Code via its programmatic/streaming interface (Agent SDK /
`stream-json`) under the user's interactive subscription login. Exposes a session
API over the tailnet: start/resume a session, send a message, stream events
(text, tool calls, results). Owns the workspace folder.

**3.2 Dashboard host + service router**
Watches the workspace folder. Exposes a **registry** — a JSON manifest of
available surfaces (`id`, `title`, `url`, `kind`, `created`, `updated`) — and
serves them at **stable tailnet URLs**. A surface comes in two `kind`s, both
rendered identically by the client:
- **`file`** — a static-ish artifact (HTML/JS) the host serves directly. Live only
  via calls to the data endpoint.
- **`service`** — a full app running in its own container (see 3.4). The host runs
  a **reverse proxy** mapping the surface's stable tailnet URL to the container's
  port, so a running app looks identical to a served file from the client's side.

**Files and services converge here:** the agent picks the simplest `kind` that
does the job, and everything downstream (registry, client rendering, persistence)
is the same.

**3.3 Data endpoint**
A sanctioned API that dashboards call for **live data**, so they are never static.
- Sources are **declared in config** (e.g. a SQL connection, a REST passthrough,
  files on the box).
- Each source is opt-in **`read`** or **`read-write`**.
- Writes go through the endpoint as **structured operations** against
  read-write sources — a dashboard never gets raw DB/shell access.
- Write actions surface a **confirmation** in the client (with a per-dashboard
  "trust this one" toggle) and append to the **audit log**.

**3.4 Infrastructure capability (agent tools)**
Exposed to Claude Code as first-class tools, so every action renders as a card in
the agent panel and is auditable.
- **Proxmox control** — full VM/container lifecycle: create, modify/resize,
  start/stop, **destroy** — via a **scoped Proxmox API token** (not root), so the
  agent's reach is bounded by what that token can touch.
- **Database provisioning** — spin up a database (e.g. Postgres) for a task and
  **auto-register it as a declared data source** in the data endpoint, so
  "create a DB" and "wire a dashboard to it" are one continuous flow.
- **Guardrails:** destructive/infra ops (create, resize, destroy) require a
  confirmation in the client; reads/listing do not. Everything appends to the
  audit log. Scoped credentials cap the worst case.

**Spawned services (container-isolated).** A `service` surface is "a dashboard
whose runtime is a Proxmox container the agent provisioned." The agent:
- Writes the app code + a **service manifest** (`type: service`, `start` command,
  `port`, optional `resources`) into the workspace.
- Provisions a dedicated **Proxmox LXC/container** as the runtime — so isolation,
  CPU/RAM limits, and lifecycle (start/stop/restart/destroy) come from the infra
  capability above, not from new bespoke machinery.
- Registers the service in the **registry** via the dashboard host's reverse proxy
  (3.2), which maps a stable tailnet URL to the container's port.
- **Container = blast-radius boundary.** Arbitrary long-running code is allowed,
  but only inside its container; the scoped token, audit log, and confirmations
  still apply. **Raw processes on the host are not permitted** — every service is
  containerized.
- The host applies a **health/restart policy** (restart on crash, restore on
  reboot) and cleans up dead services.

**3.5 Ontology**
The system's central, persistent memory — a knowledge graph stored as
**Obsidian-style markdown + wikilinks**, so it is both **agent-queryable** and
**human-browsable in Obsidian**.
- **System layer:** nodes for VMs, containers, databases, data sources,
  dashboards, and tasks; edges like `runs-on`, `reads-from`, `writes-to`,
  `supports`, `created-by`.
- **Domain layer:** nodes for the user's real-world entities and their
  relationships, giving the agent and every dashboard one consistent vocabulary.
- **Linked:** the two layers connect via edges like "this database stores these
  domain entities" / "this dashboard visualizes these domain entities."
- The agent reads/writes the ontology via a tool. Every infra op, DB
  provisioning, and dashboard creation updates it. The **audit log is the event
  stream; the ontology is the current-state model.**

**3.6 Audit log**
Append-only record on the box of every write-back and infrastructure operation.
Feeds confirmations and provides the temporal history behind the ontology.

### Client (Tauri desktop app, on the laptop)

**3.7 Agent panel (chat-first)**
A polished, Claude-desktop-style UI rendering the agent stream: conversation
thread, **tool calls as cards/diffs** (file edits as diffs, commands as
collapsible cards, plans/todos as real UI), and a **session sidebar**. Same
engine as Claude Code, our own desktop skin.

**3.8 Canvas (flexible workspace)**
Tabs, each a webview pointed at a registry URL, persisting across reconnects. Any
dashboard can **detach into its own native window** (Tauri multi-window) — e.g.
onto a second monitor — and re-dock. v1 includes light window management: detach,
re-dock, remember positions. Default layout is agent-left / canvas-right;
flexibility is additive.

**3.9 Connection layer**
Points at the box's Tailscale hostname; handles auth to the agent and dashboard
hosts; manages reconnection.

---

## 4. Core loop (data flow)

1. You message the agent → client streams it to the **agent host** → Claude Code
   works in the workspace.
2. Claude Code writes a dashboard artifact (HTML/JS + a manifest entry) into the
   workspace folder, and updates the **ontology**.
3. **Dashboard host** sees the new file → serves it at a stable URL → updates the
   **registry**.
4. Client subscribes to the registry → a new tab appears in the **canvas** →
   webview loads it over Tailscale.
5. The dashboard calls the **data endpoint** for live data (read, or write with
   confirmation + audit) → renders → **persists** for next time.
6. For complex tasks, the agent may use **infrastructure tools** (provision a DB,
   adjust a VM) — each gated, audited, and reflected in the **ontology**.

**Service variant of the loop:** when a static file isn't enough, at step 2 the
agent instead writes app code + a service manifest, provisions a **container**,
and starts the app. The dashboard host's reverse proxy maps a stable URL to the
container port and registers it as a `service` surface. From step 4 onward the
client treats it exactly like a `file` surface — a persistent, interactive tab.

---

## 5. Scope

### In scope for v1
- Server-side Claude Code on the user's existing subscription, reachable from the
  client.
- Dashboard host: serve artifacts at stable tailnet URLs + registry.
- Data endpoint: declared sources, **read + write** with per-source opt-in,
  confirmations, and audit.
- Infrastructure capability: **full VM lifecycle** (incl. destroy) with strong
  confirmations + scoped token; **database provisioning** that auto-registers as a
  data source.
- **Agent-spawned full backend services**, each isolated in its own
  **Proxmox-managed container**, registered through the dashboard host's reverse
  proxy and rendered identically to file dashboards. Includes the routing proxy +
  health/restart policy. (Raw host processes are *not* permitted — containers
  only.)
- Ontology: **system + domain layers, linked**, stored as Obsidian-style markdown.
- Tauri client: chat-first agent panel + flexible canvas with detachable windows.
- Assumes **Tailscale + Proxmox are already set up**.

### Explicitly deferred (YAGNI for v1)
- Multi-user, dashboard sharing / marketplace.
- Mobile clients.
- Tailscale / Proxmox auto-provisioning or install wizard.

---

## 6. Key assumptions
- **Name:** RHUMBR.
- **"Existing Claude subscription"** = Claude Code's normal interactive login
  running on the server, not API keys.
- Single user (the operator) for v1.
- Tailscale provides the trust boundary; the box's services are reachable only on
  the tailnet.

---

## 7. Open questions / risks
- **Subscription auth on a headless server:** confirm Claude Code's interactive
  login can be established and persisted on the Proxmox box (this is the linchpin
  of the whole value prop and should be validated early).
- **Blast radius of infra tools:** a scoped Proxmox token bounds it, but the exact
  token scope and the confirmation UX for `destroy` need care.
- **Write-back guardrails:** define the structured-operation shape so dashboards
  can write without arbitrary access.
- **Ontology update discipline:** ensuring the markdown graph stays consistent as
  the agent mutates it (idempotent writes, conflict handling).
- **Dashboard ↔ data-endpoint contract:** how a served page authenticates to the
  data endpoint over the tailnet.
- **Service routing & health:** the reverse-proxy URL→container-port mapping,
  health-check/restart policy, restore-on-reboot, and cleanup of dead services.
- **Container build cost:** dependency installs (`npm`/`pip`) and image/template
  reuse so spawning a service isn't slow every time.
- **Service blast radius:** containerization bounds it, but confirm the container
  template's default network access on the tailnet is appropriately limited.
