# PVE Node Facts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project the Proxmox host into the ontology (`node-<name>` + `runs-on` edges) from a `node-facts.json` artifact refreshed best-effort from the PVE API; the System map gains a Nodes section at the top.

**Architecture:** A `createPveCall` helper extracted from `proxmox.ts` feeds a new `infra/nodeFacts.ts` refresher that atomically writes `node-facts.json`; the projector reads it synchronously like every other artifact. Refresh is awaited in `GET /ontology` before sync-on-read and fired-and-forgotten on infra `onMutate`.

**Tech Stack:** TypeScript/Express/vitest (agent-host); React/vitest (client). No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-12-node-facts-design.md`.
- ESM `.js` import suffixes in agent-host.
- Refresh/sync failures must never 500 the endpoint or fail an infra op.
- `runs-on → node-*` edges only when exactly one node in the facts file.
- Only `RHUMB_PROXMOX_*` gates the refresher (not `RHUMB_PG_ADMIN`).

---

### Task 1: Extract `createPveCall`; add the node-facts refresher

**Files:** Modify `agent-host/src/infra/proxmox.ts`; Create `agent-host/src/infra/nodeFacts.ts`; Test `agent-host/test/node-facts.test.ts`.

**Interfaces:** Produces `createPveCall(cfg): PveCall` where `type PveCall = (method: string, path: string, body?: Record<string, unknown>) => Promise<unknown>`; `NodeFacts { fetchedAt: string; nodes: Array<{ name; status; uptimeSec?; cores?; memBytes?; pveVersion?; cpuModel?; address; storage: {id; usedPct}[] }> }`; `createNodeFactsRefresher({ call, address, path, now }): () => Promise<NodeFacts>`; `readNodeFactsFile(path): NodeFacts | null`.

Steps: failing tests (fixture `call` → refresh writes file with shape; `/status` failure degrades props; `/nodes` failure rejects; `readNodeFactsFile` on missing/corrupt → null) → red → implement (refactor `createProxmoxClient` onto `createPveCall`; refresher per spec, `atomicWriteFileSync`) → green (incl. full agent-host suite: proxmox refactor must not break infra tests) → commit `feat(agent-host): node-facts refresher on shared PVE call helper`.

### Task 2: Project node facts (+ reserved prefix)

**Files:** Modify `agent-host/src/ontology/projector.ts`, `agent-host/src/ontology/ops.ts`; Test `agent-host/test/ontology-projector.test.ts`, `agent-host/test/ontology-ops.test.ts`.

**Interfaces:** `SyncDeps` gains required `readNodeFacts: () => NodeFacts | null`. Node id `node-<name>`, props per spec (`factsAsOf`, `storage_<sanitized>` keys); container/vm `runs-on` edge iff `facts.nodes.length === 1`. `RESERVED_PREFIX` gains `node`.

Steps: failing tests (node projected with props incl. `storage_local_lvm`; single-node container+vm `runs-on`; two nodes → no `runs-on`; null facts → no node; `upsert({id:"node-x"})` throws reserved) → red → implement → green → commit `feat(agent-host): project PVE node facts into the ontology`.

### Task 3: Wire refresh into router + app

**Files:** Modify `agent-host/src/ontology/router.ts`, `agent-host/src/ontology/config.ts` (+`types.ts`: `nodeFactsPath`), `agent-host/src/index.ts`; Test `agent-host/test/ontology-router.test.ts`, `agent-host/test/index.smoke.test.ts`.

**Interfaces:** `createOntologyRouter({ ops, refresh? })` — handler `await deps.refresh?.()` in try/catch before sync. `index.ts`: refresher built iff `infra.proxmox` (outside the pgAdmin-gated block), passed to router; `onMutate` prepends `void refreshFacts?.().catch(() => {})` (sync stays synchronous); `readNodeFacts: () => readNodeFactsFile(onto.nodeFactsPath)` added to the `syncSystem` deps; `nodeFactsPath` defaults `<workspace>/node-facts.json`.

Steps: failing router tests (refresh called before sync; rejecting refresh → still 200 + nodes) → red → implement → green (full suite + build) → commit `feat(agent-host): refresh node facts on ontology read and infra mutations`.

### Task 4: Client Nodes section

**Files:** Modify `client/src/lib/ontologyStore.ts`; Test `client/test/ontologyStore.test.ts`.

Steps: failing test (`groupNodes` with a `node`-type entry → first section labeled "Nodes", before Dashboards) → red → implement (`SECTIONS.unshift`-equivalent literal) → green (tsc + full client suite) → commit `feat(client): Nodes section roots the System map`.

### Task 5: Verify + PR

Full suites (agent-host, dashboard-host untouched, client + cargo), push `feat/ontology-node-facts`, PR to main linking the spec.
