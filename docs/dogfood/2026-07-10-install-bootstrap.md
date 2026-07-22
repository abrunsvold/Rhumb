# Dogfood: guided install bootstrap on the live box

**Date:** 2026-07-10 · **Verdict: PASS** (one pre-run bug found and fixed; four follow-ups filed)
**Subject:** [`scripts/install.sh`](../../scripts/install.sh) from PR #35, run against MicroPX
**Design/plan:** [spec](../superpowers/specs/2026-07-09-install-bootstrap-design.md) · [plan](../superpowers/plans/2026-07-09-install-bootstrap.md)

## What this run was for

PR #35 shipped the installer with a `--dry-run` smoke test but no live verification — by design, deferred to a post-merge run. This is that run. It also **cut the box over** from the ad-hoc tarball deploy (F15: "no git checkout, no deploy mechanism, tribal knowledge") to the supported install, so the box now updates with `git pull && sudo scripts/install.sh`.

The box was *not* a clean target. It ran a live, healthy deployment: `rhumbr-agent`/`rhumbr-dashboard` on 8787/8788 behind `tailscale serve`, workspace at `/root/rhumbr-workspace` (printer-tracker + filament-spools surfaces, printer-poller service in LXC 105). That made it the more valuable test: a fresh box would not have surfaced most of what follows.

## Found before running: D1 (fixed, PR #36)

Reading the installer against the box's real `/root/rhumb.env` showed the env file it writes **never mentions `RHUMB_PROXMOX_URL`, `RHUMB_PROXMOX_TOKEN_ID`, `RHUMB_PROXMOX_TOKEN_SECRET`, `RHUMB_PROXMOX_NODE`** — the four variables that, per `agent-host/src/infra/config.ts:9-15`, are required *together* to enable the entire infrastructure capability (VM lifecycle, LXC provisioning, spawned services).

A user following the new 3-command quickstart could never turn any of it on, and nothing would say why. The variables were missed because that file reads them by destructuring (`const { RHUMB_PROXMOX_URL, ... } = env`), so the `env.RHUMB_*` grep used when writing the installer's documentation block never saw them.

Fixed in PR #36 along with `NODE_TLS_REJECT_UNAUTHORIZED` (Proxmox ships a self-signed cert; this box has needed it since the first infra run) and `RHUMB_PROMPT_APPEND`. The smoke test now asserts each is documented, so the next destructured variable cannot silently vanish from the config docs.

## Sequence

1. Backed up env files, unit definitions, serve status, and the registry to `/root/rhumb-preinstall-backup-20260710-110208.tgz`.
2. `git clone` to `/root/Rhumb` — the box's first git checkout.
3. `--dry-run --stage-dir` against the real box: preflight all green (node 20.19.2, npm, tailscale 1.98.8, python3, systemd), `User=root`, `WorkingDirectory=/root/Rhumb/agent-host`.
4. `systemctl disable --now rhumbr-agent rhumbr-dashboard`; confirmed 8787/8788 free.
5. Ran `scripts/install.sh --yes` with token, allowlist, ports, model, permission mode and **`RHUMB_WORKSPACE=/root/rhumbr-workspace`** pre-seeded. Exit 0.
6. Migrated 13 infra keys from the old env below the optional-settings marker; restarted.

## Verified

| Claim | Evidence |
|---|---|
| Installer completes on a real box | exit 0; both units `active` + `enabled` |
| Workspace preserved | 3 surfaces still in `/registry`; `printer-tracker` and `filament-spools` both 200 |
| Fail-closed identity | `/registry` without an identity header → 403 |
| Whole path through `tailscale serve` | `/.well-known/rhumb.json`, `/registry`, `/surfaces/printer-tracker/`, `/healthz`, `/agent/healthz` all 200 over the real HTTPS origin |
| Agent host gets its credentials | `/proc/<pid>/environ` holds all four `RHUMB_PROXMOX_*` plus `RHUMB_PG_ADMIN` |
| **Restart on crash** | `kill -9` the agent → new PID, `NRestarts=1`, `/healthz` 200; journal shows `code=killed, status=9/KILL` → `Scheduled restart job` |
| Reboot persistence (wiring) | `multi-user.target.wants/` symlinks present for both; `systemd-analyze verify` clean |
| **Re-run is the update path** | `git pull && scripts/install.sh --yes` with *no* env pre-seeding → `/etc/rhumb/rhumb.env` **byte-identical**, mode 600, migrated Proxmox block intact 4/4; both units restart healthy |
| **The install actually works** | real `claude-opus-4-8` turn through the installed host returned `INSTALL-OK`; `session` → `assistant` → `result` events on the turn stream |
| Spawned service untouched | LXC 105 running, poller `/health` 200 throughout |

Not verified: an **actual host reboot** — rebooting MicroPX drops all four LXCs, and the operator declined. Persistence rests on the enable-symlinks and `systemd-analyze verify` above.

## Findings

- **D1 — installer omitted the Proxmox credentials** (Important; **fixed**, PR #36). Above.
- **D2 — no path to import an existing deployment's config** (Important). The installer prompts for the 7 core values and writes the rest as commented placeholders. Adopting the box's live deployment meant hand-copying 13 keys (Proxmox ×4, PG admin, deploy key, LXC ×4, app origins, control token, TLS flag) below the marker. "Re-run is the update path" only helps *after* a first install. A `--import-env FILE` flag, or detecting a plausible existing env file and offering to carry its keys, would remove the sharpest remaining edge of F15.
- **D3 — the default workspace silently diverges from an existing one** (Important). `RHUMB_WORKSPACE` defaults to `/var/lib/rhumb/workspace`. Had it not been pre-seeded here, both hosts would have come up healthy and green against an **empty** workspace: every surface gone from the registry, the poller orphaned. The installer sees `/root/rhumbr-workspace` in no way at all. It should look for an existing workspace (a sibling `workspace/`, or one named in an env file it's about to replace) and prompt with it as the default rather than the blank path.
- **D4 — `setup-serve.sh`'s trailer leaks into the installer's output** (Low; predicted by the final review). Mid-install it prints `Set on BOTH hosts before starting them: RHUMB_ALLOWED_USERS=...`, which the installer has already done. Confusing in context. Reuse-by-invocation was the deliberate choice; the trailer should be suppressed when called from the installer.
- **D5 — `Restart=on-failure` is weaker than what it replaced** (Low). The legacy units used `Restart=always`. A host that exits 0 (a clean but unintended shutdown) will not come back. `kill -9` restarts because that's a signal failure; `process.exit(0)` would not. Consider `Restart=always` for a durability-first product.
- **D6 — the dashboard host holds credentials it never uses** (Important; tracked). Both units share one `EnvironmentFile`, so `/proc/<dashboard-pid>/environ` **confirmed live** holds `CLAUDE_CODE_OAUTH_TOKEN`, `RHUMB_PG_ADMIN`, and the Proxmox token. The dashboard host is the more exposed process (serves surfaces, reverse-proxies spawned services). Closed PR #33 had this right with split `agent-host.env`/`dashboard-host.env`. Additive to fix: shared file keeps its name, agent unit gains a second `EnvironmentFile=` line.
- **D7 — no collision detection against a legacy deployment** (Low). The installer's units are `rhumb-agent`/`rhumb-dashboard`; the legacy ones were `rhumbr-agent`/`rhumbr-dashboard` (extra `r`). Run naively on this box, both pairs would have fought for 8787/8788 and the new pair would have crash-looped — while the installer's verify step, which accepts any HTTP code except `000`, would have seen the *old* hosts answering and reported success. Verify should confirm it is talking to the process it just started (e.g. compare against the unit's MainPID), and preflight should refuse to proceed when the target ports are already held by a foreign unit.

D3 and D7 share a root cause worth naming: **the installer assumes it is the only thing that has ever deployed Rhumb on this box.** That is true of the fresh-box story the README tells, and false of every box that already runs it.

## Box state after the run

- `rhumb-agent` + `rhumb-dashboard`: active, enabled, serving; checkout at `/root/Rhumb` (`bfc71a8`), config `/etc/rhumb/rhumb.env` (600, root), workspace `/root/rhumbr-workspace`.
- Legacy `rhumbr-*` units: **stopped and disabled**, unit files left in place for rollback.
- `tailscale serve` unchanged: `/` → 8788, `/agent` → 8787.
- Untouched: LXC 105 (printer-poller), the stale transient `rhumb-pr21-*` units on 9787/9788, `/root/rhumb` (old tarball code).
- Rollback: `systemctl disable --now rhumb-agent rhumb-dashboard && systemctl enable --now rhumbr-agent rhumbr-dashboard`.
