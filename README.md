# Rhumb

**A self-hosted platform that turns Claude Code into a persistent, interactive workspace running on your own hardware.**

Most ways of working with a coding agent leave you with a chat transcript. The agent can build dashboards and live-data UIs, but the moment the session ends you can't *keep* or *interact with* what it made. Rhumb lets the agent **materialize durable, interactive surfaces** that run as real services on your box, reachable from a desktop client over a [Tailscale](https://tailscale.com) mesh, and persist across sessions.

> **Status:** early, actively built, not yet production-hardened. **All seven roadmap subsystems are now implemented** — the agent host, the dashboard host, the data endpoint, the infrastructure capability (Proxmox/LXC + database provisioning), spawned container-isolated services, the Tauri v2 desktop client, and the persistent ontology (see [Roadmap](#roadmap)).

---

## Why Rhumb

- **Use your existing Claude subscription — or an API key or gateway instead.** In the default mode, server-side Claude Code runs under your normal interactive login rather than pay-per-token billing; api-key and gateway modes are also supported (see below).
- **Outputs are durable, not disposable.** The agent builds dashboards and apps that stay running and reachable at stable URLs.
- **Your compute, your data.** Nothing lives in a hosted SaaS. Everything durable — the agent, your data, the apps it builds — runs on a box you control.
- **The agent operates your infrastructure.** On the roadmap: it can manage VMs and provision databases to support real work, not just read data.
- **Full applications, not just static dashboards.** The agent can spawn complete backend services, each isolated in its own Proxmox-managed container.

---

## Who it's for — and what you'd build

**People who already self-host.** If you've got a Proxmox node in a closet and a backlog of little jobs that deserve a real tool but never get one — a 3D-printer tracker, a runbook wiki, a homelab status board — Rhumb is a **homelab-native internal-tools builder**: you describe the tool, an agent builds it, provisions its backend, and leaves it running on your own hardware.

What sets Rhumb apart is that the agent **stands up the backend *and* the UI *and* registers them together**, on a box you own — you describe the tool, you don't wire it up yourself.

The on-ramp is homelab-grade (Proxmox + Tailscale + your own Claude credentials), so the honest framing is *fast internal tools for people who already self-host* — not for everyone.

**→ See [docs/positioning.md](docs/positioning.md)** for the full persona and 8 example tools (each mapping to a Rhumb subsystem).

---

## Before you deploy: the "personal tool" shape comes from Anthropic's terms

The code is [Apache-2.0](LICENSE) — you're free to read, run, modify, and redistribute it, including commercially. That much this repository grants you outright.

Rhumb authenticates Claude one of three ways, selected with `RHUMB_LLM_PROVIDER`:

| `RHUMB_LLM_PROVIDER` | Credentials | Notes |
|---|---|---|
| `subscription` (default) | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Uses your existing Claude subscription rather than pay-per-token billing. Carries the personal-tool constraint below. |
| `api-key` | `ANTHROPIC_API_KEY` | Ordinary pay-per-token API access. No personal-tool constraint. |
| `gateway` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (**required** — use `none` for an auth-free gateway), explicit `RHUMB_MODEL` | Point Rhumb at an Anthropic-compatible endpoint — a LiteLLM proxy, an internal gateway, or a self-hosted open model behind one. Nothing need leave your network. |

**The personal-tool constraint applies to `subscription` mode only.** That mode
authenticates with an OAuth token tied to your own Claude subscription, and
Anthropic's terms restrict third-party developers from *offering* claude.ai login
or rate limits to other people inside their own products. So in subscription mode
Rhumb is built around the single-operator model — your hardware, your credentials,
no "sign in with Claude" layer for anyone else.

In `api-key` and `gateway` mode that restriction does not apply: those are ordinary
credentials governed by whatever terms you hold with the relevant provider. See
[COMPLIANCE.md](COMPLIANCE.md) for the full reasoning.

**Gateway mode requires `ANTHROPIC_AUTH_TOKEN`, and the agent host refuses to
start without it.** If your gateway needs no auth, set it to the literal value
`none`. The reason it cannot simply be left blank: with no auth token in its
environment, Claude Code falls back to whatever claude.ai login is stored on the
box (macOS keychain or `~/.claude/.credentials.json`) and sends *that* to your
gateway as `Authorization: Bearer sk-ant-oat01-...`. The `none` sentinel makes
Rhumb inject a non-credential placeholder instead, so the CLI never reaches for
your stored login.

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

**Principle:** everything durable lives **server-side**. The client is a rich remote window; the heavy lifting and your Claude credentials stay on the box where the compute is. Subsystems are joined by a shared `RHUMB_WORKSPACE` folder — a file-as-contract: the agent writes surfaces into it, the dashboard host serves them.

### Packages

| Package | What it does |
|---|---|
| [`agent-host/`](agent-host/README.md) | Wraps Claude Code (Claude Agent SDK) and exposes an HTTP + SSE session API over your tailnet. Owns the workspace. Also hosts the **infrastructure capability** (Proxmox/LXC + database provisioning) and **service spawning**, both gated behind a confirmation queue. |
| [`dashboard-host/`](dashboard-host/README.md) | Watches the workspace and serves the surfaces the agent builds at stable URLs, plus the registry the client reads. Also exposes the **data endpoint** (read/write Postgres access with write guardrails) and reverse-proxies **spawned services** at stable URLs. |
| [`client/`](client/) | Tauri v2 desktop client — a Rust core (SSE + control-plane proxy, so the hosts need no CORS) with a React/TS UI: agent panel, canvas of live surfaces, and confirmation dialogs for gated writes and infra actions. |

---

## Quickstart

**Prerequisites:** a Linux box with systemd on your [Tailscale](https://tailscale.com) tailnet, [Node.js](https://nodejs.org) 20+, and Claude credentials (a subscription, an API key, or an Anthropic-compatible gateway).

```sh
git clone https://github.com/abrunsvold/Rhumb && cd Rhumb
claude setup-token      # subscription mode only — the installer also accepts an API key or a gateway URL
sudo scripts/install.sh
```

The installer checks prerequisites (telling you exactly what to fix if one is missing), auto-detects your tailnet login for the access allowlist, prompts for whichever Claude credentials your selected mode needs (an OAuth token, an API key, or a gateway URL), builds both hosts, mounts them behind `tailscale serve`, and installs systemd units (`rhumb-agent`, `rhumb-dashboard`) so everything starts on boot and restarts on crash. When it finishes it prints your Rhumb URL.

All configuration lives in one file, `/etc/rhumb/rhumb.env`, with the optional settings (Postgres provisioning, spawned-service LXC knobs, ontology paths) documented inline as commented-out lines. The installer is idempotent: after `git pull`, re-run it to rebuild and restart — your configuration is preserved. If an ambient shell variable (e.g. an exported `ANTHROPIC_API_KEY`) differs from the value already persisted in `rhumb.env`, the installer warns by name — never printing a secret's value — and uses the ambient one, so a re-run can't silently clobber a saved credential without you noticing.

> **First run:** if `tailscale serve` has never been used on your tailnet, the installer pauses and prints a `login.tailscale.com` link — a tailnet admin must click it once to enable Serve (and HTTPS certificates, if prompted) before setup can continue.

Running on macOS, without systemd, or want to see every step? **[docs/setup-manual.md](docs/setup-manual.md)** has the step-by-step path, plus local development without a tailnet and a troubleshooting guide.

### Connect the client

The [`client/`](client/) is a Tauri v2 desktop app. Build and run it with the Tauri CLI:

```sh
cd client
npm install
npm run tauri dev       # or `npm run tauri build` for an installable app bundle
```

On first launch it discovers boxes running `tailscale serve` with Rhumb's `/.well-known/rhumb.json` manifest and lists them in a picker — click one to connect. If discovery finds nothing (e.g. the `tailscale` CLI isn't available on your laptop), enter the box's HTTPS origin manually instead.

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
- **Smooth the on-ramp.** `scripts/install.sh` now takes a box from clone to supervised, tailnet-served hosts in one guided run. Next: prebuilt desktop-client releases so connecting doesn't require a Rust toolchain.
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
