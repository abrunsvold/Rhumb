# Guided server bootstrap + README quickstart rewrite

**Date:** 2026-07-09 · **Status:** approved design
**Addresses:** the "Smooth the on-ramp" near-term priority (README Goals) — setup is homelab-grade, with many manual steps between `clone` and a running tool, and nothing survives a reboot.

## Problem

Installing Rhumb on a box today means: `claude setup-token`, run `scripts/setup-serve.sh`, then in **each** of `agent-host/` and `dashboard-host/` run `npm install && npm run build` and hand-type a `npm start` line with env vars (`CLAUDE_CODE_OAUTH_TOKEN`, `RHUMB_ALLOWED_USERS`, `RHUMB_WORKSPACE`). Nothing supervises the processes — a reboot or crash silently kills the deployment (the real box runs the hosts ad hoc). Configuration lives nowhere durable; the allowlist must be typed twice; the ~25 optional env vars (`RHUMB_DATA_SOURCES`, `RHUMB_PG_ADMIN`, LXC knobs…) are discoverable only by reading two package READMEs.

## Decision

One **interactive, idempotent bootstrap script** — `scripts/install.sh` — that takes a fresh Debian-ish box from `git clone` to two supervised, tailnet-served hosts, plus a README quickstart that shrinks to three commands. Chosen over docs-only (doesn't fix reboot fragility or double data entry) and over container/LXC packaging (bigger lift, changes the deployment story; can layer on later — the env file + units this pass produces are what an image would bake in anyway).

Decisions locked with the operator:

- **Supervision: systemd units**, not a foreground start script. Matches the real target (Debian LXC on Proxmox); fixes reboots for good. Requires sudo and Linux — acceptable; macOS/dev stays on the manual path.
- **Input UX: interactive with detection.** Auto-detect what we can, prompt for the rest, allow env-var/flag pre-seeding so unattended re-runs work.
- **Client packaging is out of scope** this pass. The client section of the README keeps build-from-source with exact commands.

## Design

### `scripts/install.sh`

Run from the repo root on the box: `sudo scripts/install.sh` (sudo needed for `/etc/rhumb` and systemd; the units run as the invoking user via `SUDO_USER`).

1. **Preflight** — check `node >= 20` (parse `node --version`), `npm`, `tailscale` CLI present and logged in (`tailscale status`), systemd present (`systemctl`). Each failure prints a one-line remedy (e.g. the NodeSource/apt command, `tailscale up`) and exits. Missing `claude` CLI is a warning only — the token can be minted on any machine.
2. **Detect & prompt** — auto-detect the tailnet login from `tailscale status --json` (same parse `setup-serve.sh` does) and propose it as `RHUMB_ALLOWED_USERS`; prompt for `CLAUDE_CODE_OAUTH_TOKEN` (no-echo read; point at `claude setup-token` if they don't have one); offer defaults for port (8787/8788), workspace (`/var/lib/rhumb/workspace`), model, permission mode. **Every prompt is pre-seedable**: if the value arrives via environment or an existing config file, the prompt shows it as the default (secrets shown masked); `--yes` accepts all defaults for unattended runs.
3. **Write config** — single `EnvironmentFile` at `/etc/rhumb/rhumb.env`, mode 600 root-owned, holding the core vars shared by both hosts. All **optional** vars (`RHUMB_DATA_SOURCES`, `RHUMB_DATASOURCE_*`, `RHUMB_PG_ADMIN`, `RHUMB_LXC_*`, `RHUMB_SERVICES`, `RHUMB_DEPLOY_KEY`/`PUBKEY`, `RHUMB_ONTOLOGY`, `RHUMB_APP_ORIGINS`, `RHUMB_DATA_TRUST`, audit paths…) are included as commented-out lines with a one-line explanation each — the env file doubles as configuration documentation. On re-run, existing values are preserved as prompt defaults (parse the current file first); user comments/uncommented optional vars are kept.
4. **Build** — `npm ci && npm run build` in `agent-host/` and `dashboard-host/`, as the invoking user (not root).
5. **Serve** — mount both hosts behind `tailscale serve` (`--set-path=/agent` → agent port, `/` → dashboard port). Reuse `setup-serve.sh` by invoking it (keep it as the standalone/manual-path tool) rather than duplicating the logic. Surface its first-run pause (`login.tailscale.com` approval link) verbatim.
6. **systemd** — install `rhumb-agent.service` and `rhumb-dashboard.service` from templates checked into `scripts/systemd/` (envsubst-style fill of user, repo path, workspace). Both: `EnvironmentFile=/etc/rhumb/rhumb.env`, `WorkingDirectory=<repo>/<pkg>`, `ExecStart=/usr/bin/env npm start` (or the resolved `node dist/index.js`), `Restart=on-failure`, `User=<invoking user>`, `After=network-online.target tailscaled.service`. `daemon-reload`, `enable --now` both.
7. **Verify & report** — wait briefly, check `systemctl is-active` on both units and curl each host's health/root endpoint via loopback; print the serve URL (`https://<box>.ts.net`, dashboard at `/`, agent at `/agent`), the allowlisted login, and where the config lives. On failure, print `journalctl -u rhumb-agent -n 50`-style triage lines.

**Idempotent re-run = the update path.** After `git pull`, re-running rebuilds and restarts with config preserved. Partial-failure safe: `set -euo pipefail`, every step either skips cleanly when already done or redoes safely (serve mounts replace, `npm ci` is clean-slate, unit files overwrite, `enable --now` is idempotent).

**Not handled:** installing Node/Tailscale themselves (preflight tells you how), Postgres setup, client builds, non-systemd hosts (→ manual doc).

### README rewrite

Quickstart becomes: prerequisites (a Linux box on your tailnet, Node 20+, a Claude subscription) then

```sh
git clone … && cd rhumb
claude setup-token     # on any machine — you'll paste the token into the installer
sudo scripts/install.sh
```

…then "Connect the client" (unchanged in substance, exact commands spelled out). The current step-by-step (per-package npm runs, env vars, `RHUMB_INSECURE_DEV` local-dev section, the two-port/no-tailnet caveats) moves to **`docs/setup-manual.md`**, linked from the quickstart ("running on macOS, without systemd, or want to see every step? → manual setup"). A short **Troubleshooting** subsection in the manual doc covers the known first-run snags: Serve not enabled on the tailnet, HTTPS certs, host refuses to start without `RHUMB_ALLOWED_USERS`, client discovery finding nothing.

Security-model section stays in the README unchanged; the quickstart links to it before the install command, as now.

### Testing

- `shellcheck`-clean (verified locally as part of the implementation; noted in the script header).
- A non-root `--dry-run` mode makes the script testable: full flow, writes config/units to a stage directory, executes nothing privileged. A checked-in smoke test (shell script under `scripts/test/`) drives `--dry-run --yes` with seeded env vars and asserts the staged env file and unit files — including the re-run/preserve behavior.
- Real verification is a live run on the box (dogfood pattern): fresh-ish install, reboot, confirm both units come back and the client connects.

## Out of scope

Prebuilt client releases/CI artifacts; Docker/LXC template packaging; Postgres installation; hardening beyond what exists. Each can build on the env-file + units contract this introduces.
