# Rhumb

**A self-hosted platform that turns Claude Code into a persistent, interactive workspace running on your own hardware.**

Most ways of working with a coding agent leave you with a chat transcript. The agent can build dashboards and live-data UIs, but the moment the session ends you can't *keep* or *interact with* what it made. Rhumb lets the agent **materialize durable, interactive surfaces** that run as real services on your box, reachable from a desktop client over a [Tailscale](https://tailscale.com) mesh, and persist across sessions.

> **Status:** early, actively built, not yet production-hardened. **All seven roadmap subsystems are now implemented** — the agent host, the dashboard host, the data endpoint, the infrastructure capability (Proxmox/LXC + database provisioning), spawned container-isolated services, the Tauri v2 desktop client, and the persistent ontology (see [Roadmap](#roadmap)).

---

## Why Rhumb

- **Use your existing Claude subscription.** Server-side Claude Code runs under its normal interactive login — not pay-per-token API billing.
- **Outputs are durable, not disposable.** The agent builds dashboards and apps that stay running and reachable at stable URLs.
- **Your compute, your data.** Nothing lives in a hosted SaaS. Everything durable — the agent, your data, the apps it builds — runs on a box you control.
- **The agent operates your infrastructure.** On the roadmap: it can manage VMs and provision databases to support real work, not just read data.
- **Full applications, not just static dashboards.** The agent can spawn complete backend services, each isolated in its own Proxmox-managed container.

---

## Who it's for — and what you'd build

**People who already self-host.** If you've got a Proxmox node in a closet and a backlog of little jobs that deserve a real tool but never get one — a 3D-printer tracker, a runbook wiki, a homelab status board — Rhumb is a **homelab-native internal-tools builder**: you describe the tool, an agent builds it, provisions its backend, and leaves it running on your own hardware.

What sets Rhumb apart is that the agent **stands up the backend *and* the UI *and* registers them together**, on a box you own — you describe the tool, you don't wire it up yourself.

The on-ramp is homelab-grade (Proxmox + Tailscale + your own subscription), so the honest framing is *fast internal tools for people who already self-host* — not for everyone.

**→ See [docs/positioning.md](docs/positioning.md)** for the full persona and 8 example tools (each mapping to a Rhumb subsystem).

---

## Before you deploy: the "personal tool" shape comes from Anthropic's terms

The code is [Apache-2.0](LICENSE) — you're free to read, run, modify, and redistribute it, including commercially. That much this repository grants you outright.

The one thing to understand first is a constraint between **you and Anthropic**, not something this license adds or removes: Rhumb authenticates Claude with **your own Claude subscription**, via an OAuth token from `claude setup-token` (not an API key). Anthropic's terms restrict third-party developers from **offering** claude.ai login or rate limits to other people inside their own products. So Rhumb is built around the single-operator model, because that's the clean path through those terms:

- You run it on **your own hardware**, with **your own credentials**.
- Out of the box it doesn't broker, proxy, or multiplex Claude login to anyone else, and there's no "sign in with Claude" layer.

If you want to build a multi-tenant or hosted offering on top of it, clearing that with Anthropic is yours to do — the license won't do it for you. See [COMPLIANCE.md](COMPLIANCE.md) for the full reasoning.

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

**Principle:** everything durable lives **server-side**. The client is a rich remote window; the heavy lifting and your Claude subscription stay on the box where the compute is. Subsystems are joined by a shared `RHUMB_WORKSPACE` folder — a file-as-contract: the agent writes surfaces into it, the dashboard host serves them.

### Packages

| Package | What it does |
|---|---|
| [`agent-host/`](agent-host/README.md) | Wraps Claude Code (Claude Agent SDK) and exposes an HTTP + SSE session API over your tailnet. Owns the workspace. Also hosts the **infrastructure capability** (Proxmox/LXC + database provisioning) and **service spawning**, both gated behind a confirmation queue. |
| [`dashboard-host/`](dashboard-host/README.md) | Watches the workspace and serves the surfaces the agent builds at stable URLs, plus the registry the client reads. Also exposes the **data endpoint** (read/write Postgres access with write guardrails) and reverse-proxies **spawned services** at stable URLs. |
| [`client/`](client/) | Tauri v2 desktop client — a Rust core (SSE + control-plane proxy, so the hosts need no CORS) with a React/TS UI: agent panel, canvas of live surfaces, and confirmation dialogs for gated writes and infra actions. |

---

## Quickstart

You'll need [Node.js](https://nodejs.org), a Claude subscription, and (for the intended setup) a Proxmox host and a Tailscale tailnet. You can also run everything on a single machine to try it out.

### 1. Get a Claude token

```sh
claude setup-token        # produces a long-lived CLAUDE_CODE_OAUTH_TOKEN
```

### 2. Put both hosts behind `tailscale serve`

On the box, run the setup script once. It mounts both hosts behind a single
tailnet HTTPS origin and prints the tailnet login(s) to allowlist:

```sh
scripts/setup-serve.sh
```

### 3. Set the allowlist and run the agent host

`RHUMB_ALLOWED_USERS` is a comma-separated list of tailnet logins (e.g.
`alice@github`) permitted to reach the hosts. Set it on **both** hosts — they
refuse to start without it:

```sh
cd agent-host
npm install
npm run build
CLAUDE_CODE_OAUTH_TOKEN=... RHUMB_ALLOWED_USERS=you@github npm start
```

Defaults: port `8787`, model `claude-opus-4-8`, workspace `./workspace`, permission mode `acceptEdits`. The host binds loopback only — `tailscale serve` is what makes it reachable from the tailnet. See [`agent-host/README.md`](agent-host/README.md) for all environment variables and the security model behind permission modes.

### 4. Run the dashboard host

Point it at the **same workspace** as the agent host, with the same allowlist:

```sh
cd dashboard-host
npm install
npm run build
RHUMB_WORKSPACE=../agent-host/workspace RHUMB_ALLOWED_USERS=you@github npm start
```

Defaults: port `8788`, loopback bind. See [`dashboard-host/README.md`](dashboard-host/README.md).

### 5. Connect the client

The [`client/`](client/) is a Tauri v2 desktop app. Build and run it with the Tauri CLI (`npm install` then `npm run tauri dev` from `client/`). On first launch it discovers boxes running `tailscale serve` with Rhumb's `/.well-known/rhumb.json` manifest and lists them in a picker — click one to connect. If discovery finds nothing (e.g. the `tailscale` CLI isn't available on your laptop), you can enter the box's single HTTPS origin manually instead.

### Local development without a tailnet

Set `RHUMB_INSECURE_DEV=1` on both hosts to skip identity checks and the
loopback-only bind entirely — useful for running everything on one machine
without Tailscale. **Never set this on a box reachable by anyone else**: it
disables the Tailscale identity allowlist and all of the request
authentication described in [`SECURITY.md`](SECURITY.md).

---

## Security model — read before exposing anything

- **The agent host runs Claude Code autonomously** with Bash and Write access to its host machine. The `RHUMB_PERMISSION_MODE` setting controls how much is gated — **`bypassPermissions` removes all gating** and lets the agent run any command or file write without confirmation. Only use it in fully trusted, isolated environments. Details in [`agent-host/README.md`](agent-host/README.md#security).
- **The dashboard host authenticates every request against your Tailscale identity allowlist** (`RHUMB_ALLOWED_USERS`), fronted by `tailscale serve`. It serves whatever is under `<workspace>/surfaces/` to allowlisted logins only. See [`SECURITY.md`](SECURITY.md) for the full threat model.
- **Expose Rhumb only over Tailscale.** None of these services are designed to face the public internet.
- Both hosts refuse paths that escape their workspace/surface folders, but the rule of thumb stands: this is your machine, running an autonomous agent, reachable from your devices — keep it on your private network.

---

## Roadmap

Rhumb is built as a sequence of self-contained plans (spec → plan → TDD implementation), all sharing the `RHUMB_WORKSPACE` contract. Specs and plans live in [`docs/superpowers/`](docs/superpowers/).

1. **Agent host** ✅ — Claude Code session API over the tailnet.
2. **Dashboard host + registry** ✅ — serve durable surfaces at stable URLs.
3. **Client** ✅ — Tauri v2 desktop shell: Rust SSE + control-plane proxy and a React UI (agent panel, canvas, confirmation dialogs).
4. **Data endpoint** ✅ — read/write Postgres access, with writes gated by a confirmation queue and surface-scoped guardrails.
5. **Infrastructure capability** ✅ — agent-managed Proxmox LXC containers and database provisioning, each action gated behind human confirmation.
6. **Spawned services** ✅ — the agent builds full backend apps, each isolated in its own container and reverse-proxied at a stable URL.
7. **Ontology** ✅ — a persistent, browsable markdown graph of your environment and domain, projected automatically from the other subsystems' state and queryable by the agent.

> Milestones marked ✅ are implemented with tests on `main`; they are **not** yet security-hardened for hostile networks — see [Security model](#security-model--read-before-exposing-anything) and keep Rhumb on your tailnet.

---

## Goals

**Guiding principles** — what stays true regardless of what gets built:

- **Durable by default.** Everything the agent makes is a real, persistent service, not a disposable chat artifact. If you can't keep it and come back to it, it doesn't belong in Rhumb.
- **Your compute, your data.** Nothing durable lives in a hosted SaaS. The agent, your data, and the tools it builds all run on hardware you control.
- **The agent operates the system, not just reads it.** The aim is an agent that can provision databases, manage containers, and stand up services — each gated behind confirmation, but genuinely operational.
- **Single-operator by design.** Rhumb is shaped for one person running it on their own credentials (see [the note above](#before-you-deploy-the-personal-tool-shape-comes-from-anthropics-terms)). That constraint keeps the security model honest.

**Near-term priorities** — where the work points now that all seven subsystems ship:

- **Harden for less-trusted networks.** Rhumb currently assumes a private tailnet. Tighten the agent-host permission model and workspace path handling so a mistake costs less — the hosts now authenticate against a Tailscale identity allowlist, but the model still assumes a single trusted operator.
- **Smooth the on-ramp.** Setup is still homelab-grade. Better first-run docs, clearer defaults, and fewer manual steps between `clone` and a running tool.
- **Dogfood real tools.** Build and run actual internal tools on Rhumb and let what breaks drive the roadmap — rather than adding subsystems for their own sake.
- **Stability over surface area.** With the seven subsystems in place, the emphasis shifts from new capabilities to making the existing ones reliable and well-tested.

---

## Contributing

Issues and pull requests are welcome. By submitting a contribution you agree it is licensed under the terms below (Apache-2.0, §5).

When working in a package, match its existing conventions and keep the test coverage — the subsystems are built with TDD and the workspace contract is load-bearing across them.

---

## License

[Apache License 2.0](LICENSE). Copyright 2026 Rhumb contributors.

Apache-2.0 was chosen for its explicit patent grant and clear contributor terms, maximizing how freely you can read, run, and adapt Rhumb. It grants no rights in Anthropic's or Tailscale's trademarks, and it doesn't change your obligations under Anthropic's terms — see [the note above](#before-you-deploy-the-personal-tool-shape-comes-from-anthropics-terms).
