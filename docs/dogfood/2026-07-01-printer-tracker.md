# Dogfood run — Creality K2 Plus printer tracker

**Date:** 2026-07-01 · **Goal:** first real internal tool built end-to-end on Rhumb, per the "Dogfood real tools" near-term priority. Let what breaks drive the roadmap.

## Target

Two Creality **K2 Plus** printers on the LAN, running Klipper + Moonraker:

| Printer | Moonraker | Hostname |
|---|---|---|
| Left | `http://192.168.1.53:7125` | `K2Plus-FE91` |
| Right | `http://192.168.1.62:7125` | `K2Plus-Right` |

Moonraker `/printer/objects/query` returns `print_stats` (filename, state, print/total duration, filament_used, info.current/total_layer, z_pos), `heater_bed` + `extruder` (temp/target/power), `display_status.progress`, `virtual_sdcard` (progress, is_active, layer, layer_count).

## Setup reality (pre-run findings)

The previous staged deploy on MicroPX was **wiped** (no `/root/rhumb*`, no systemd units, no Node). A live run required a **full redeploy from repo**: install Node 20, build both hosts, regenerate secrets (control token, PVE token secret — the old one died with the env, deploy keypair, OAuth token), expose Postgres (survived inside LXC 102), and re-point everything. Memory corrected.

> **Roadmap signal (on-ramp):** a live run after any env loss is a multi-step manual redeploy. A single `deploy.sh` / documented runbook that installs Node, builds, templates the env (prompting for the OAuth token), and writes the systemd units would turn ~15 manual steps into one. Directly serves the "Smooth the on-ramp" goal.

## The build turn

One goal-directed turn (`turnId: printer-tracker-1`), model `claude-opus-4-8`. The agent: explored the workspace + ontology, verified both Moonraker endpoints live, designed a 3-table schema, provisioned the DB, built + smoke-tested + spawned the poller, (dashboard + ontology pending). Behavior was careful and well-sequenced — read platform source to learn deploy conventions before shipping.

## Findings

### F1 — `AskUserQuestion` has no channel in the headless/HTTP-driven model *(minor / UX)*
The agent used its built-in `AskUserQuestion` tool to confirm the first gated action. Driven over HTTP (no interactive stdin), it returned empty answers twice; the agent fell back to "proceed with default." The **real** control — `canUseTool` → `/infra/pending` — worked correctly. So no safety hole, but the agent wastes turns on an unanswerable prompt.
**Action:** document that operator confirmation happens via the pending queue, not the agent's own questions; consider steering the system prompt away from `AskUserQuestion` for gated infra actions (the gate already prompts the operator).

### F2 — no `psql` on the host *(trivial / self-healed)*
Agent wanted `psql` to apply schema; not installed. It pivoted to Node + `pg` (spun up a throwaway `db/` applier). Fine, but worth either shipping a tiny schema-apply helper or documenting "use `pg`, not `psql`."

### F3 — `spawn_service` injects no data-source connection, runs no remote install *(HIGH / real gap)*
Reading `services/ops.ts` + `manifest.ts`, the agent found the deployer sets only `PORT` and `RHUMB_SERVICE_BASE` in the service's systemd env — **not the `DATABASE_URL` of the DB it just provisioned** — and runs **no remote `npm install`**. A service that talks to a provisioned DB must bake its own connection string into a shipped config file and **vendor `node_modules`** into the pushed dir. The agent worked around it (config.json + vendored `pg`), but this is friction for the single most common pattern (service → provisioned DB).
**Action:** when a service is linked to a data source, inject its connection string as env (e.g. `RHUMB_DATASOURCE_<id>` / `DATABASE_URL`); optionally run `npm ci` remotely on deploy.

### F4 — `spawn_service` provisions no runtime; Node services crash-loop in a bare container *(BLOCKER for Node services / real gap)*
The `ubuntu-24.04-standard` LXC has no Node. `manifest.start = node index.js` → **`node: command not found` (exit 127)**, systemd restart-looping (counter hit 28 in seconds). The local smoke test passed only because the *host* has Node — masking the gap. The deploy pushes code + writes a `Restart=always` unit but never installs the service's runtime.
**Action (highest-value from this run):** `spawn_service` must provision the runtime in the container — either a runtime field in the manifest (`runtime: node20`) that triggers an install step, a base template/image with Node preinstalled, or a documented bootstrap the deploy runs. Without this, no interpreted-language service works out of the box.

### F5 — local smoke test masks container reality *(process lesson)*
The agent smoke-tested the poller **on the host** (Node present) and saw it work end-to-end (printers upserted, telemetry flowing) — then shipped to a container where `node` doesn't exist. The green smoke test gave false confidence and F4 only surfaced post-spawn.
**Action:** any pre-spawn validation should run in an environment matching the container (or the deploy should guarantee the runtime, per F4).

## Outcome — SUCCESS (agent self-recovered)

Despite F4, the agent **recovered autonomously**: it SSH'd into LXC 105 with the deploy key, spent several minutes working through apt/dpkg, installed **Node 18**, and the `Restart=always` unit picked the poller up. Verified ground truth ~90 min in:

- **542 telemetry samples and climbing**, both printers, live data (bed ~23.8 °C / nozzle ~24.9 °C, `standby`), 0 open jobs (correct — both idle).
- Poller health `{"ok":true, printers:[K2Plus-FE91, K2Plus-Right], lastTick:…}`; `services.json` → `healthy`.
- Surface `http://<host>:8788/surfaces/printer-tracker/` → HTTP 200, queries DB via the token-auth `/data` API, 5s auto-refresh.
- Ontology: `datasource-printers`, `service-printer-poller`, `container-105`, `dashboard-printer-tracker` — all linked and traversable.

**Read of it:** the full stack (provision DB → spawn service → surface → ontology) composed in one gated turn and produced a real, running tool — the positioning.md "whole stack in one build" claim held. But it only worked because the driving agent was capable enough to hand-fix F4 with container surgery; a less capable agent (or a non-Node runtime) would have been stuck. **F4 is the top roadmap item** from this run: `spawn_service` must guarantee the service runtime. F3 (inject data-source connection + remote install) is the close second. Everything else (F1, F2, F5) is minor.

### Verification note
The agent's own progress reports were accurate/conservative (said "46+ samples" while the true count was higher). The one discrepancy during the run — a watcher reading `telemetry_rows=0` — was a *timing* artifact (pre-F4-fix window), not a false claim; confirmed by direct DB query afterward.

## Client
The Tauri desktop client (`client/`) compiled cleanly on macOS (first Rust build ~4 min) and launched — exercising the open C1/C2 runtime-verification item. Connects via `ConnectionScreen` (agent base, dashboard base, control token); Rust proxy bridges SSE. Surface viewable both in the client canvas and any tailnet browser.

## Fixes landed (same session)

**F4 + F3 fixed** — spec `docs/superpowers/specs/2026-07-01-service-runtime-and-datasource-design.md`, implemented test-first in `agent-host/src/services/`:
- Manifest gains optional `runtime` (`node`|`python`|`none`) and `dataSources: [id]`.
- Deployer installs the runtime in the container before enabling the unit (`apt-get install -y nodejs npm` / `python3…`), runs a conditional remote `npm ci --omit=dev` (kills the vendoring workaround), and emits an `Environment=` line per injected data-source connection.
- Ops resolves each `dataSources` id → `RHUMB_DATASOURCE_<ID>` (+ `DATABASE_URL` when single) from `data-sources.json`, failing fast before provisioning on an unknown id.
- Agent-host suite **98/98** (was 78; +20 new tests), build clean, redeployed to the box and boots; existing `printer-poller` unaffected (no runtime field → old behavior).

### F6 — fresh spawned containers have broken DNS (Tailscale MagicDNS, no tailscaled) *(BLOCKER for any remote install)*
Surfaced while **live-verifying the F4/F3 fix.** A freshly-spawned LXC inherits `/etc/resolv.conf` = `nameserver 100.100.100.100` + search `*.ts.net` (Tailscale MagicDNS, from the tailnet-connected PVE host) but runs no `tailscaled` → **all DNS resolution fails**. `apt-get install` hangs forever in its download method with zero bytes fetched (0 debs, no established connections). The LAN gateway `192.168.1.1:53` *is* reachable, so it's purely a resolver-config problem. Writing `nameserver 192.168.1.1` into the container instantly recovered apt (debs 0 → 428). The original poller only worked because the agent hand-installed Node at a moment DNS happened to resolve.
**Action:** `LxcClient.create` (or the deploy preamble) must set a working nameserver — e.g. `pct set <id> --nameserver 192.168.1.1` / a public resolver, or write `resolv.conf` before the runtime install. Without this, the F4 runtime install (or any `apt`/`npm` fetch) can't work. Pairs with F4 — a spawned service isn't self-sufficient until it has both a runtime *and* DNS.

**Capstone verification — FAILED (and that's the finding).** Unit tests pass (98/98) and the new code path demonstrably *runs* (the deployer executed the runtime-install + env-injection in a fresh container). But the live re-spawn **could not complete**: F6 (DNS) hung `apt` indefinitely; after a manual `resolv.conf` fix `apt` reached 428 debs, but the whole thing was so slow/fragile on a 1-core/512 MB container that the spawn eventually errored and **rolled back (container destroyed, poller left down)**. So the fix as written is **necessary but not sufficient**. Two concrete gaps it exposed:
- **F6 must be fixed in code** — set a working nameserver on LXC create (the first-build agent even installed a persistent `rhumb-dns-fix.service`; see the service's `SETUP.md`). Without DNS, no `apt`/`npm` fetch works.
- **Installing `npm` is too heavy.** The distro `npm` package drags in a huge `node-*` tree — slow and fragile in a small container. The first-build agent installed **only `nodejs`** and vendored `node_modules`. The fix should install `nodejs` alone and run `npm ci` **only when the service isn't already vendored** (or move to NodeSource, whose `nodejs` bundles `npm` without the sprawling tree). Right-size container resources too.

**Net:** the fix's *direction* is right (manifest `runtime`/`dataSources`, deployer install + env injection) but it needs a **v2**: fix F6, install `nodejs`-only, and re-verify live. Meanwhile the tracker's poller is down (DB + surface intact) pending either that v2 or a manual restore.

## v2 fix — implemented and live-verified (PASSED)

Test-first in `agent-host/src/services/`:
- **F6:** `ServiceConfig.nameserver` (env `RHUMB_LXC_NAMESERVER`, default `1.1.1.1`) threaded through `ops.spawn` → `LxcSpec.nameserver` → `lxc.ts`'s Proxmox `POST /lxc` body (untested live wrapper, consistent with `proxmox.ts`). A fresh container now gets a working resolver instead of inheriting the tailnet host's unusable Tailscale MagicDNS config.
- **Lighter runtime install:** deployer now installs bare `nodejs` (`--no-install-recommends`) unconditionally, and only pulls the heavy `npm` apt package + runs `npm ci --omit=dev` when the pushed dir has a `package.json` **and** isn't already vendored (checked locally via `existsSync`, before push — no wasted remote round trip).
- Suite **103/103** (was 98, +5), build clean, redeployed and boots.

**Capstone re-run — PASSED, ground-truth verified** (destroyed nothing this time; spawned `printer-poller` fresh with `config.json`/`node_modules` still stripped from the earlier test):
- Registered `healthy` in ~30s (vs. the ~10min stall/failure of v1) — new container `105` @ `192.168.1.95`.
- `/etc/resolv.conf` in the container → `nameserver 1.1.1.1` (F6 fix applied by the platform).
- `node -v` → `v18.19.1`; `dpkg -l` confirms both `nodejs` and `npm` packages installed **by the deployer** (package.json present, nothing vendored, so the npm branch correctly engaged).
- `config.json` absent (never restored) → `Environment=DATABASE_URL=…` and `RHUMB_DATASOURCE_PRINTERS=…` present in the systemd unit — proves the connection came from **injected env**, not a baked file.
- `node_modules/pg*` present — proves the remote `npm ci` ran.
- Poller health: `{"ok":true,"printers":["K2Plus-FE91","K2Plus-Right"]}`; telemetry climbing (810+, fresh timestamps); surface `HTTP 200`; both printer rows present.

**Verdict:** F4, F3, and F6 are now fixed, unit-tested, and **proven live** — a service declaring `runtime: node` + `dataSources` can be spawned into a bare LXC template completely hands-off (no manual DNS fix, no manual Node install, no vendored deps required). This closes the loop the dogfood run opened: build → break → fix → re-verify live, twice, until it actually held up.

