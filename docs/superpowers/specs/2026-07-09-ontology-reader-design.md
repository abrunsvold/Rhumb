# Ontology reader — the sidebar becomes the system map

**Date:** 2026-07-09
**Status:** approved
**Prior art:** `2026-07-01-ontology-design.md` (the write side), day-2 dogfood F16 (stale ontology addresses), repo value-vs-liability audit (2026-07-09).

## Problem

The ontology is write-only. The projector faithfully rebuilds the system layer
on every infra mutation, but nothing consumes it: no client UI, no HTTP
endpoint, and the system prompt never tells the agent the four ontology tools
exist. Dogfooding proved the cost of that: F16 found the vault holding a dead
poller IP while `services.json` had the live one, and the agent — the only
possible reader — cross-checked and trusted the live file instead. Sync
failures are silently swallowed (`catch {}` in `agent-host/src/index.ts`), so
drift is invisible. A plausible-looking source of truth that quietly goes
stale is a liability, not a subsystem.

## Decision

Give the ontology two real consumers, and make staleness impossible for one
and visible for both:

1. **The operator, via the client sidebar.** The ▦ rail section stops being a
   flat surfaces list and becomes the **System map**: the ontology's type
   scheme *is* the navigation taxonomy.
2. **The agent, via the prompt.** One paragraph in `RHUMB_PROMPT_APPEND`
   telling the agent the ontology tools exist and what they're for.

## Server side (agent-host)

### `GET /ontology` (identity-gated like every other route)

Response:

```json
{
  "nodes": [ { "type", "id", "title", "managed", "created", "updated", "props", "relationships" } ],
  "syncedAt": "2026-07-09T…",
  "syncError": null
}
```

- **Sync-on-read:** the handler runs `ontologyOps.sync()` before answering, so
  a reader can never see a projection older than its own request. This is the
  F16 fix — snapshotted host/port props are re-derived from
  `services.json`/`data-sources.json`/surfaces/audits at read time.
- **Errors surface, never block:** if sync throws, the handler still returns
  the nodes currently on disk, with `syncError` set to the message and
  `syncedAt` reflecting the last *successful* sync. A broken projector must
  not take down navigation.

### Ops additions (`ontology/ops.ts`)

- `list(): OntologyNode[]` — all system + domain nodes (the internal
  `allNodes()` made public).
- `status(): { syncedAt: string | null; syncError: string | null }` —
  `sync()` records its outcome here (success clears the error, failure stores
  the message and rethrows). The `onMutate` hook keeps its catch — infra ops
  must never fail on a sync error — but the failure is now recorded and
  visible instead of discarded.

### Prompt (`prompt.ts`)

Append: the workspace has a persistent ontology (markdown graph) of what runs
on the box; use `mcp__ontology__query` to orient before infra work; record
durable domain knowledge with `upsert_node`/`link`; the system layer is
regenerated from live state, the domain layer is yours.

## Client side

### Data path

- Rust proxy command `get_ontology(agent_base)` → `GET /ontology` via
  `agent_target` + `shell_request` (same SSRF-pinned pattern as every other
  command).
- `getOntology(agentBase)` binding in `lib/tauri.ts`; `OntologyNode` /
  `OntologySnapshot` types mirrored per the existing polyglot-by-contract
  convention.
- Fetch on panel open + a refresh button. No SSE stream: sync-on-read makes
  every fetch fresh, and a vault watcher is complexity the panel doesn't need
  (YAGNI; revisit only if the panel grows stale-while-open complaints).

### `OntologyPanel` (replaces `SurfacesPanel`)

- **Sections per node type, fixed order:** Dashboards, Services, Containers,
  Data sources, VMs, Domain. Empty sections are omitted.
- **Filter box** at the top: case-insensitive substring match over id, title,
  and prop values; filters all sections live.
- **Dashboard nodes** keep today's behavior exactly: click → select that
  surface on the canvas (node id `dashboard-<id>` maps to the registry tab
  `<id>`; nodes with no live registry tab render disabled). The canvas and its
  registry stream are unchanged.
- **All other nodes** expand inline to a read-only detail card: props,
  relationships ("runs-on → CT 105"), managed badge (system/domain).
- **Header:** "synced <relative time>" plus a warning banner when `syncError`
  is set.
- Pure helpers (`groupNodes`, `filterNodes`) live in `lib/ontologyStore.ts`,
  tested independently of the component.
- Rail: section id `"surfaces"` stays (minimal churn); label/tooltip becomes
  "System map".

## Out of scope (deliberately)

- Graph visualization / canvas rendering of the ontology.
- Editing or creating nodes from the client (the domain layer stays
  agent-authored; the vault stays Obsidian-editable).
- Exposing the ontology via dashboard-host (would duplicate vault parsing
  across hosts — the exact liability the audit flagged).
- SSE/streaming updates of the ontology.

## Testing

- **agent-host:** router test — sync invoked per GET, response shape, sync
  failure → `syncError` + disk nodes still returned, route rejected without
  identity (matches `/infra` gating tests). Ops tests — `list()`, `status()`
  transitions on success/failure.
- **client:** `ontologyStore` tests — grouping order, filtering, prefix
  mapping. `OntologyPanel` tests — sections render, filter narrows, dashboard
  click calls `onSelect` with the registry id, disabled when no live tab,
  detail expand, sync-error banner. Workspace test updated for the panel swap.
- **Rust:** `get_ontology` follows the tested `agent_target` pattern; no new
  logic beyond the request line.

## Failure modes considered

- Projector throws mid-sync (bad JSONL line, unreadable vault): endpoint
  degrades to last-good nodes + visible error; panel shows banner.
- Vault empty / ontology dir missing: `nodes: []`, panel shows empty state.
- Dashboard node without registry tab (surface dir exists, registry hasn't
  caught up, or dashboard-host down): disabled row, no dead click.
- Huge audit logs make sync slow: pre-existing cost (audit chip
  task_0055b835), unchanged here; sync-on-read adds no *new* full-file reads
  beyond what every infra mutation already does. If it becomes slow, fix the
  projector's audit reads, not the reader.
