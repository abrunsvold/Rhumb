# Spawned-service runtime + data-source injection — design

**Date:** 2026-07-01 · **Origin:** dogfood findings F4 (BLOCKER) + F3 (HIGH), see `docs/dogfood/2026-07-01-printer-tracker.md`.

## Problem

`spawn_service` provisions a bare `ubuntu-24.04-standard` LXC, pushes the service dir, and writes a `Restart=always` systemd unit running `manifest.start` via `bash -lc` — but:

- **F4:** it never installs a runtime. A Node service crash-loops `node: command not found`. The container has no `node`/`npm`.
- **F3:** the unit env carries only `PORT` + `RHUMB_SERVICE_BASE`, not the connection string of the DB the agent just provisioned, and nothing runs a remote `npm install`. Services must hand-vendor `node_modules` and bake a config file.

## Design

All changes converge on `agent-host/src/services/`. `deployer.ts` stays pure (no fs / no secrets resolution); `ops.ts` resolves secrets and hands the deployer an env map.

### Manifest (`types.ts`, `manifest.ts`)
Two new **optional** fields on `ServiceManifest` (backward-compatible — omit = today's behavior):
- `runtime?: "node" | "python" | "none"`
- `dataSources?: string[]` — ids of registered data sources this service needs.

`validateManifest`: if present, `runtime` must be one of the three literals; `dataSources` must be an array of valid data-source id strings.

### Deployer (`deployer.ts`)
`deploy(target, localDir, manifest, extraEnv?)` — new optional `extraEnv: Record<string,string>`.
1. `mkdir` + `pushDir` (unchanged).
2. **Runtime install** (before the unit), based on `manifest.runtime`:
   - `node` → `apt-get update && apt-get install -y nodejs npm`; then, if `package.json` exists in the pushed dir, `cd <remoteDir> && npm ci --omit=dev || npm install --omit=dev`.
   - `python` → `apt-get update && apt-get install -y python3 python3-pip python3-venv`.
   - `none` / undefined → no install (today's behavior).
3. **Unit env:** keep `PORT` + `RHUMB_SERVICE_BASE`; append one `Environment=<k>=<v>` line per entry in `extraEnv`.
4. daemon-reload + `enable --now` (unchanged).

apt install runs non-interactively (`DEBIAN_FRONTEND=noninteractive`). Node comes from the distro repo (Node 18 on Ubuntu 24.04) — simple, offline via distro mirror, matches the manual fix that worked in the dogfood run.

### Ops (`ops.ts`)
`createServiceOps` gains a `resolveDataSource: (id: string) => string | undefined` dep (returns a connection string). During `spawn`, build `extraEnv`:
- For each id in `manifest.dataSources`: `RHUMB_DATASOURCE_<ID_UPPER>=<connStr>` (id upper-cased, non-alphanumerics → `_`). Unknown id → throw (fail fast; don't silently ship a broken service).
- If exactly one data source: also set `DATABASE_URL=<connStr>`.
Pass `extraEnv` to `deployer.deploy(...)`.

### Wiring (`config.ts` / index)
Provide `resolveDataSource` backed by `data-sources.json` (`RHUMB_DATA_SOURCES`): read the file, find the source by id, return its connection string. Missing file → resolver returns undefined for all (spawn without `dataSources` still works).

## Security
Connection strings (with passwords) are written only into the container's root-only `/etc/systemd/system/rhumb-<id>.service`. Never logged. Consistent with existing deploy-secret handling; distinct from the ontology projector, which stays secret-free.

## Testing (TDD order, existing fake-exec harness)
1. `service-manifest.test.ts` — accept valid `runtime`/`dataSources`; reject bad values; still accept manifests without them.
2. `service-deployer.test.ts` — `runtime:"node"` emits apt install + npm ci (when package.json); `runtime:"python"` emits python install; `none`/absent emits neither; `extraEnv` → `Environment=` lines; existing assertions still pass.
3. `service-ops.test.ts` — `dataSources` resolved to `extraEnv` (DATABASE_URL for single, per-source for each); unknown id throws; no `dataSources` → no extra env.
4. Resolver unit test — reads `data-sources.json`, returns conn string / undefined.

## Out of scope
NodeSource/newer Node, multi-version runtimes, Python venv activation in `start`, health-probe changes, re-deploy/upgrade of a running service. Follow-ups if needed.
