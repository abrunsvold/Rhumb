# PVE node facts — the box roots the System map

**Date:** 2026-07-12
**Status:** approved
**Prior art:** `2026-07-09-ontology-reader-design.md` (the reader this feeds), repo audit (staleness lessons), operate-loop direction (drift detection needs ground truth about the host itself).

## Problem

The ontology maps everything *on* the box but not the box. Containers and VMs
float unrooted; the System map can't answer "what is this machine, is it up,
how big is it, how full is it" — the first facts any drift-detection or
operator loop needs.

## Decision

Project the Proxmox node(s) into the ontology as first-class system nodes,
fed by a new `node-facts.json` workspace artifact refreshed best-effort from
the PVE API. The map gains a **Nodes** section at the top; containers and VMs
gain `runs-on` edges to their node.

## Server side (agent-host)

### `node-facts.json` (file-as-contract, like services.json)

```json
{
  "fetchedAt": "2026-07-12T…",
  "nodes": [{
    "name": "MicroPX", "status": "online", "uptimeSec": 123456,
    "cores": 8, "memBytes": 16700000000,
    "pveVersion": "pve-manager/9.0-3/…", "cpuModel": "Intel(R) N100",
    "address": "https://192.168.1.100:8006",
    "storage": [{ "id": "local-lvm", "usedPct": 41 }]
  }]
}
```

- **Refresher** (`infra/nodeFacts.ts`): `GET /nodes`, then per node
  `GET /nodes/{n}/status` (pveversion, cpuinfo.model) and
  `GET /nodes/{n}/storage` (usage %). Per-node sub-calls degrade
  independently — a failing status call drops those props, never the node.
  Atomic write via `fsAtomic`. `address` comes from the configured
  `RHUMB_PROXMOX_HOST` base URL.
- **Shared call scaffolding:** `createPveCall(cfg)` extracted from
  `proxmox.ts` (audit flagged the duplication; the refresher reuses it
  instead of adding a third copy).
- **Triggers:** awaited before sync-on-read in `GET /ontology` (failure →
  stale file, still 200); fire-and-forget on infra `onMutate` (the sync that
  follows reads whatever is on disk; freshness there is best-effort).
- **Gating:** created only when `RHUMB_PROXMOX_*` is configured (proxmox
  alone — does not require `RHUMB_PG_ADMIN`). Unconfigured → no file → map
  unchanged.

### Projector

- New system type `node`, id `node-<name>`, title `<name>`. Props: `status`,
  `address`, `factsAsOf` (the file's `fetchedAt` — staleness is visible, the
  F16 lesson), plus when available `pveVersion`, `cpuModel`, `cores`,
  `memoryGb`, `uptimeDays`, and one `storage_<id>` prop per pool
  (`"41% used"`, id sanitized to `[A-Za-z0-9_]`).
- `container-*` and `vm-*` nodes gain `runs-on → node-<name>` **only when
  exactly one node exists** — with one node placement is certain; multi-node
  placement mapping (via `/cluster/resources`) is deferred, not guessed.
- `SyncDeps` gains required `readNodeFacts: () => NodeFacts | null`
  (null/missing/invalid file → no node projected).
- `node-` joins the reserved id prefixes in ops upsert validation.

## Client

- `SECTIONS` in `ontologyStore.ts` gains `{ type: "node", label: "Nodes" }`
  **first** — the box roots the map. Older clients fold the unknown type into
  Domain (graceful skew).
- No new components: nodes are non-dashboard rows, so the existing detail
  card renders props and relationships as-is.

## Out of scope

- Live metrics / usage history (monitoring is a surface's job).
- Multi-node placement edges (deferred with the single-node guard).
- New env vars (reuses `RHUMB_PROXMOX_*`; `node-facts.json` path is derived
  from the workspace, no override).

## Testing

- `nodeFacts.test.ts`: refresher against a fake `call` — file written
  atomically with the right shape; status/storage sub-call failures degrade
  per-node; top-level `/nodes` failure throws (caller treats as best-effort).
- `ontology-projector.test.ts`: node projected with props + storage keys;
  single-node → `runs-on` on container and vm; two nodes → no `runs-on`;
  `readNodeFacts: () => null` → no node.
- `ontology-router.test.ts`: refresh awaited before sync; refresh rejection
  still 200 with nodes.
- `ontology-ops.test.ts`: `node-x` upsert rejected as reserved.
- client `ontologyStore.test.ts`: Nodes section first.
- Real PVE HTTP paths stay fake-injected (matches the existing pattern; the
  untested-real-client gap is a known audit follow-up).
