# RHUMBR Ontology Design Spec (Plan 7 of 7)

**Date:** 2026-07-01
**Status:** Approved design (sub-spec of the RHUMBR master spec §3.5 ontology).
**Depends on:** the workspace/file-as-contract (all plans), the data endpoint + sources (Plan 4), the infra capability + audit (Plan 5), spawned services (Plan 6). Reads their current-state artifacts; adds no coupling to their code.

Grounded against the master spec §3.5: a knowledge graph stored as Obsidian-style markdown + wikilinks, agent-queryable and human-browsable; the **audit log is the event stream, the ontology is the current-state model**.

---

## 1. Role

The ontology is RHUMBR's **persistent current-state model** — a knowledge-graph vault (Obsidian-style markdown + wikilinks) of everything the system knows:
- a **system layer** — the infrastructure Plans 4–6 build (data sources, services, containers, VMs, dashboards) — **projected automatically** from the current-state artifacts those plans already maintain, so it never drifts; and
- a **domain layer** — the operator's real-world entities — **authored by the agent**, with the two layers **linked** (e.g. "this database *stores* these customers").

It is **agent-queryable** through in-process tools and **human-browsable in Obsidian** (the vault is plain markdown). It is the capstone that gives the agent and the operator one coherent, browsable model of the environment and its data.

## 2. Architecture

- **Agent host** owns the vault store, the projector, the graph query engine, and four **ungated** MCP tools (they only write workspace markdown — like the agent building surfaces — so no `canUseTool` gating).
- **The vault** lives at `<workspace>/ontology/` and is the single source of truth for the graph. It is plain markdown, so Obsidian (pointed at the workspace or the `ontology/` folder) browses it directly.
- **No coupling to Plans 4–6 code:** the projector *reads* their existing artifacts (`data-sources.json`, `services.json`, the surface manifests, the audit logs). Nothing in those plans changes.

### 2.1 Storage + ownership boundary

The ownership split is what keeps the vault clean and the projector idempotent:

- **`<workspace>/ontology/system/<id>.md`** — **projector-owned.** `ontology_sync` fully regenerates these from the current-state artifacts. Not hand-edited; sync may delete one when the underlying thing is gone.
- **`<workspace>/ontology/domain/<id>.md`** — **agent-owned.** Domain entities the agent creates via `ontology_upsert_node`. `ontology_sync` never reads or writes `domain/`.
- **Cross-layer links are authored from the domain side.** An agent edge like "database stores customer" is written on the **domain** node (`domain/customer.md` → `- stored-in [[database-ops]]`), never on the projector-owned system node — so a re-projection can never clobber an agent's link. The query engine indexes edges **bidirectionally**, so the same fact answers "what does database-ops store?" from the reverse direction.

### 2.2 Node + edge schema

A node is one markdown file, `<id>.md`, where `id` is URL-safe (`^[A-Za-z0-9._-]+$`):

```markdown
---
type: service            # datasource | service | container | vm | dashboard | entity
id: demo-svc
title: Demo Service
managed: system          # system (projector-owned) | domain (agent-owned)
created: 2026-07-01T04:56:42Z
updated: 2026-07-01T04:56:42Z
# type-specific props (e.g. port, mode, host) as additional frontmatter keys
---

## Relationships
- runs-on [[container-105]]
- created-by [[agent]]
```

- **Node types:** system — `datasource`, `service`, `container`, `vm`, `dashboard`; domain — `entity` (the agent sets a domain-specific subtype in frontmatter, e.g. `subtype: customer`).
- **Relationships** are typed wikilink bullets `- <edge> [[target-id]]` in a `## Relationships` section — each bullet is a **directed edge from its containing node to the target** — machine-parseable *and* rendered as edges in Obsidian's graph view.
- **Edge types.** Projector-authored (on system nodes): `runs-on`, `reads-from`, `writes-to`, `created-by`. Agent-authored (always **from a domain node**, so the domain node is the grammatical subject): `stored-in`, `visualizes`, `supports`, `relates-to`, `reads-from`. Because the query engine indexes edges **bidirectionally**, a domain-authored `customer stored-in [[database-ops]]` answers both "where is customer stored" (out-edge) and "what does database-ops store" (in-edge) — so no system-subject verb (`stores`) needs to be written on the projector-owned system file. Operators can add their own verbs; the engine treats any `- <verb> [[target]]` bullet as a typed directed edge.

### 2.3 Vault store (pure)

Read/write helpers over the vault: `readNode(path) -> Node | null` (parse frontmatter + relationships; a malformed file → `null`, logged), `writeNode(dir, node)` (serialize), `listNodes(dir)`. `Node = { type, id, title, managed, props, relationships: { edge, target }[] }`. Pure and unit-tested (round-trip).

### 2.4 Projector (`ontology_sync`)

Reads the current-state artifacts through injected readers and materializes the **system** layer:
- `data-sources.json` → a `datasource` node per source (props: `type`, `mode`).
- `services.json` → a `service` node + the `container` node it runs in + edge `service runs-on container` (from `containerId`; props: `host`, `port`, `status`).
- `<workspace>/surfaces/*/surface.json` → a `dashboard` node per file surface.
- `data-audit.jsonl` → `dashboard reads-from` / `writes-to datasource` edges, derived from the recorded `surfaceId` → `source` write history (the one place surface↔data usage is captured). Edges are attached to the `dashboard` (system) node.
- `infra-audit.jsonl` → `vm` nodes (VMs have no registry file, so the audit is their only current-state source: apply an approved `create_vm`, remove on an approved `destroy_vm`); plus `created-by [[agent]]` + `created`/`updated` timestamps for system nodes.

Sync computes the **desired set** of system nodes + edges and rewrites `system/` to match — adding new nodes, updating changed ones, and **deleting** system nodes whose underlying thing no longer exists. It is **idempotent** and touches only `system/`. The projector depends only on the injected readers, so it is unit-tested with fakes.

### 2.5 Graph query engine

Parses the whole vault (`system/` + `domain/`) into nodes + a **bidirectional edge index**, and answers:
- `getNode(id) -> Node | null`
- `nodesByType(type) -> Node[]`
- `neighbors(id, opts?: { edge?, direction?: "out" | "in" | "both" }) -> { edge, node, direction }[]`

So "what runs-on container-105" (in-edges of `runs-on`) and "what does database-ops store" (in-edges of `stores`/reverse of `stored-in`) are single calls. Pure and unit-tested against a fixture vault.

### 2.6 MCP tools (ungated)

In-process tools in the agent host, all **allowlisted** (no confirmation — they only write workspace markdown):
| Tool | Action |
| --- | --- |
| `ontology_sync` | run the projection; returns a summary (nodes added/updated/removed) |
| `ontology_query` | `{ kind: "node", id } \| { kind: "type", type } \| { kind: "neighbors", id, edge?, direction? }` → results |
| `ontology_upsert_node` | create/update a **domain** node `{ id, title, subtype?, props? }` |
| `ontology_link` | add an edge `{ from, edge, to }` — **`from` must be a domain node** (the edge is written on `domain/<from>.md`); errors if `from` is a system node, instructing the agent to author from the domain side |

Tool handlers catch errors and return `isError:true` (never throw), matching the infra tools.

## 3. Data flow

1. The operator (or the agent) triggers `ontology_sync` → the projector reads the state artifacts and (re)builds `system/`: `datasource`, `service`, `container`, `vm`, `dashboard` nodes with `runs-on` / `reads-from` / `created-by` edges.
2. The agent authors domain knowledge: `ontology_upsert_node` (e.g. a `customer` entity) and `ontology_link` (`customer stored-in [[database-ops]]`) → written under `domain/`.
3. The agent (or a surface prompt) reasons over the graph via `ontology_query` — "what services run on which containers", "what does this database store", "which dashboards read this source".
4. The operator opens the workspace in Obsidian → browses the same graph visually; edits to `domain/` are the agent's, edits to `system/` are regenerated on the next sync.

## 4. Error handling

- A missing/corrupt state artifact or vault node → treated as empty/skipped (logged); never crashes `sync` or a query.
- `ontology_link` with a `from` that resolves to a **system** node → `isError` result explaining to author the edge from the domain side.
- `ontology_upsert_node`/`ontology_link` with an invalid `id` → rejected with a clear message. A query for an unknown node/type → an empty result, not an error.
- `ontology_sync` deleting a stale system node is safe (it only owns `system/`); a domain node referencing a now-deleted system node is left intact (a dangling wikilink, which Obsidian shows as unresolved — acceptable and visible).

## 5. Security / scoping

- The tools only read/write **workspace markdown** — the same trust surface as the agent building file surfaces. **No gating** is needed (nothing destructive, no external systems, no credentials).
- The projector reads state artifacts that already live in the workspace; it introduces **no new credential or external access**.
- The vault contains only names/ids/relationships already present in the workspace artifacts — no secrets (connection strings stay in `data-sources.json`, not copied into nodes).

## 6. Testing & verification

- **Unit (agent host):** the vault store (frontmatter + relationships round-trip; malformed file → null); the projector (fake artifact readers → expected system nodes + edges, including a `create_vm` then `destroy_vm` sequence yielding no VM node, and a `service` yielding service+container+`runs-on`); the query engine (fixture vault → `getNode`, `nodesByType`, `neighbors` in both directions incl. a reverse cross-layer lookup); the `ontology_link` ownership guard (system `from` → error); id validation.
- **Build-verified:** the four tools wired into the agent host + a smoke test that `ontology_sync` over fixture state produces the expected node files.
- **Live run (driver):** after the Plan-5/6 live artifacts exist (a provisioned DB + a spawned service), run `ontology_sync` → `system/` shows the `datasource`, `service`, and `container` nodes with the `runs-on` edge; the agent `upsert`s a domain `entity` and `link`s it `stored-in` the datasource (authored from the domain node) → `ontology_query neighbors` for the datasource with `direction:"in"` returns the entity; open the workspace in Obsidian → the graph renders the system + domain nodes and their links.

## 7. Scope / out of scope

- **In:** the vault store; the projector (system layer from `data-sources.json`, `services.json`, surface manifests, `data-audit.jsonl`, `infra-audit.jsonl`); the graph query engine; the four ungated MCP tools (`ontology_sync`, `ontology_query`, `ontology_upsert_node`, `ontology_link`); config for the vault path.
- **Out (later / deferred):** surfaces querying the ontology over HTTP (v1 is agent + Obsidian only); temporal/history queries (the audit log remains the event stream; the ontology is current-state only); auto-inferring domain entities from data content; a graph-visualization UI in the client (Obsidian is the browser); `task` nodes (no current-state source — the agent may author them as domain entities if useful); automatic re-sync on artifact change (v1 syncs on the `ontology_sync` tool call).

## 8. Implementation phases (one plan)

1. **Vault + graph core:** config (vault path); the `Node` types + vault store (parse/serialize/list); the graph query engine (bidirectional index + the three query shapes).
2. **Projection + tools:** the projector (`ontology_sync`) over the injected artifact readers; the four MCP tools; wiring into the agent host (allowlisted, alongside the infra server).

The live run (over the Plan-5/6 artifacts, then agent-authored domain nodes) verifies both phases and closes the 7-plan roadmap.
