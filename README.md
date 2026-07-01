# RHUMBR

**A self-hosted platform that turns Claude Code into a persistent, interactive workspace running on your own hardware.**

Tools like OpenClaw trap a capable agent inside a linear chat transcript. The agent underneath can build dashboards and live-data UIs — but you never get to *keep* or *interact with* what it makes. RHUMBR lets the agent **materialize durable, interactive surfaces** that run as real services on your box, reachable from a desktop client over a [Tailscale](https://tailscale.com) mesh, and persist across sessions.

> **Status:** early, actively built. The agent host, dashboard host, and client foundation are in place; the Tauri shell, data endpoint, infrastructure capability, spawned services, and ontology are on the roadmap (see [Roadmap](#roadmap)).

---

## Why RHUMBR

- **Use your existing Claude subscription.** Server-side Claude Code runs under its normal interactive login — not pay-per-token API billing.
- **Outputs are durable, not disposable.** The agent builds dashboards and apps that stay running and reachable at stable URLs.
- **Your compute, your data.** Nothing lives in a hosted SaaS. Everything durable — the agent, your data, the apps it builds — runs on a box you control.
- **The agent operates your infrastructure.** On the roadmap: it can manage VMs and provision databases to support real work, not just read data.
- **Full applications, not just static dashboards.** The agent can spawn complete backend services, each isolated in its own Proxmox-managed container.

---

## ⚠️ This is a personal tool, by design — please read

RHUMBR authenticates Claude with **your own Claude subscription** via an OAuth token from `claude setup-token`, **not** an API key.

Anthropic's terms state that, without prior approval, third-party developers may not **offer** claude.ai login or rate limits in their products — including agents built on the Claude Agent SDK. RHUMBR is therefore deliberately shaped as a **self-hosted personal tool**:

- You run it on **your own hardware**, with **your own credentials**.
- It does **not** broker, proxy, multiplex, or offer Claude login to anyone else.
- There is **no hosted RHUMBR** and no "sign in with Claude" convenience layer, by design.

**This project is open source so that you can read, run, and adapt it for yourself — not so that it can be operated as a service for third parties.** If you want to build a multi-tenant or hosted offering on top of it, that is your responsibility to clear with Anthropic first. See [COMPLIANCE.md](COMPLIANCE.md) for the full reasoning.

---

## Architecture

Two sides, joined over Tailscale:

```
  Laptop (Tauri client)                 Proxmox host (server)
  ┌─────────────────────┐    Tailscale   ┌──────────────────────────────┐
  │ Agent panel (chat)  │◄──────────────►│ Agent host (Claude Code)     │
  │ Canvas (dashboards) │                │ Dashboard host (+ registry)  │
  │ Connection layer    │                │ Data endpoint (read/write)   │
  └─────────────────────┘                │ Infra capability (Proxmox/DB)│
                                         │ Ontology (markdown graph)    │
                                         │ Workspace folder             │
                                         └──────────────────────────────┘
```

**Principle:** everything durable lives **server-side**. The client is a rich remote window; the heavy lifting and your Claude subscription stay on the box where the compute is. Subsystems are joined by a shared `RHUMBR_WORKSPACE` folder — a file-as-contract: the agent writes surfaces into it, the dashboard host serves them.

### Packages

| Package | What it does |
|---|---|
| [`agent-host/`](agent-host/README.md) | Wraps Claude Code (Claude Agent SDK) and exposes an HTTP + SSE session API over your tailnet. Owns the workspace. |
| [`dashboard-host/`](dashboard-host/README.md) | Watches the workspace, serves the surfaces the agent builds at stable URLs, and publishes the registry the client reads. |
| [`client/`](client/) | Desktop client (Vite/React/TS today; Tauri v2 shell next) — agent panel + canvas of live surfaces. |

---

## Quickstart

You'll need [Node.js](https://nodejs.org), a Claude subscription, and (for the intended setup) a Proxmox host and a Tailscale tailnet. You can also run everything on a single machine to try it out.

### 1. Get a Claude token

```sh
claude setup-token        # produces a long-lived CLAUDE_CODE_OAUTH_TOKEN
```

### 2. Run the agent host

```sh
cd agent-host
npm install
npm run build
CLAUDE_CODE_OAUTH_TOKEN=... npm start
```

Defaults: port `8787`, model `claude-opus-4-8`, workspace `./workspace`, permission mode `acceptEdits`. See [`agent-host/README.md`](agent-host/README.md) for all environment variables and the security model behind permission modes.

### 3. Run the dashboard host

Point it at the **same workspace** as the agent host:

```sh
cd dashboard-host
npm install
npm run build
RHUMBR_WORKSPACE=../agent-host/workspace npm start
```

Defaults: port `8788`. See [`dashboard-host/README.md`](dashboard-host/README.md).

### 4. Connect the client

See [`client/`](client/) for the current development client. The Tauri desktop shell is in progress (Plan 3b).

---

## Security model — read before exposing anything

- **The agent host runs Claude Code autonomously** with Bash and Write access to its host machine. The `RHUMBR_PERMISSION_MODE` setting controls how much is gated — **`bypassPermissions` removes all gating** and lets the agent run any command or file write without confirmation. Only use it in fully trusted, isolated environments. Details in [`agent-host/README.md`](agent-host/README.md#security).
- **The dashboard host is unauthenticated.** It serves whatever is under `<workspace>/surfaces/`. Expose it **only on your tailnet**, never on a public interface.
- **Expose RHUMBR only over Tailscale.** None of these services are designed to face the public internet.
- Both hosts refuse paths that escape their workspace/surface folders, but the rule of thumb stands: this is your machine, running an autonomous agent, reachable from your devices — keep it on your private network.

---

## Roadmap

RHUMBR is built as a sequence of self-contained plans (spec → plan → TDD implementation), all sharing the `RHUMBR_WORKSPACE` contract. Specs and plans live in [`docs/superpowers/`](docs/superpowers/).

1. **Agent host** ✅ — Claude Code session API over the tailnet.
2. **Dashboard host + registry** ✅ — serve durable surfaces at stable URLs.
3. **Client** — foundation ✅; Tauri v2 shell + Rust SSE proxy in progress.
4. **Data endpoint** — read/write data access with guardrails.
5. **Infrastructure capability** — agent-managed Proxmox VMs and DB provisioning.
6. **Spawned services** — full backend apps, each container-isolated.
7. **Ontology** — a persistent, browsable markdown graph of your environment and domain.

---

## Contributing

Issues and pull requests are welcome. By submitting a contribution you agree it is licensed under the terms below (Apache-2.0, §5).

When working in a package, match its existing conventions and keep the test coverage — the subsystems are built with TDD and the workspace contract is load-bearing across them.

---

## License

[Apache License 2.0](LICENSE). Copyright 2026 RHUMBR contributors.

Apache-2.0 was chosen for its explicit patent grant and clear contributor terms, maximizing how freely you can read, run, and adapt RHUMBR for your own use. Using it does not grant any rights in Anthropic's or Tailscale's trademarks, and does not change your obligations under Anthropic's terms — see [the personal-tool note above](#️-this-is-a-personal-tool-by-design--please-read).
