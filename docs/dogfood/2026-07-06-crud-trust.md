# Dogfood run — write-back / CRUD trust-gate (filament spool inventory)

**Date:** 2026-07-06 · **Spec:** ../superpowers/specs/2026-07-06-crud-trust-dogfood-design.md
**Box code:** merged main (cd1266e) — no redeploy this run.
**Claim under test:** the write-back loop (provision → write → gate → trust → audit) works end-to-end live, and the trust model's real (coarse) behavior is documented.

## Phase 0/1 — client ready + baseline

Read-only snapshot taken via SSH against `micropx-pve.tail731306.ts.net` (WS=`/root/rhumbr-workspace`, REPO_DIR=`/root/rhumb`), before any live CRUD/trust turn.

**data-sources.json** — one existing source:
- id `printers`, type `postgres`, mode `read-write` (connection string password redacted)

**data-trust.json** — absent. Trust store starts clean; any file/content appearing after the build turn is new.

**data-audit.jsonl** — absent. Baseline line count: 0. Any lines appearing after the build turn are new writes to count against.

**services.json** — one existing service:
- id `printer-poller`

**ontology** — pre-existing entries (context, not touched by this baseline):
- `ontology/domain/`: `printer-k2plus-fe91.md`, `printer-k2plus-right.md`, `print-jobs.md`
- `ontology/system/`: `container-105.md`, `dashboard-printer-tracker.md`, `datasource-printers.md`, `service-printer-poller.md`

## Phase 2 — the build turn (live log)

**Note on F20 (resolved):** the prior attempt was BLOCKED by a tooling/env issue — the dev build was a bundle-less Tauri debug binary shadowed by a launchd-relaunched stale `Rhumb.app`, so computer-use could not focus/type into it. **FIX applied:** the client is now a properly packaged app (`/Users/anderson/Applications/Rhumb.app`, bundle `com.rhumb.client`, built today from merged main — F8/F9/F14 + markdown), running as the ONLY Rhumb process (PID 24146). request_access → granted full tier; screenshot renders the window; typing focus transfers cleanly. F20 no longer blocks. What follows is the real build turn.

Timezone: EDT. Driver: computer-use (Task D3 recorder, packaged-app retry).

- **12:29:48** — Task start. `ps` confirms exactly one Rhumb process: packaged `/Users/anderson/Applications/Rhumb.app/Contents/MacOS/app` PID **24146**. No dev binary, no stale app.
- **12:29:54** — request_access("Rhumb") → granted `com.rhumb.client`, tier **full**, screenshotFiltering native. Screenshot: window titled "Rhumb", dashboard "3D Printer Tracker" **live** (updated 12:29:54), K2Plus-FE91 nozzle 25.3 / bed 23.8 Standby, "Printer Poller" tab present. Matches D1 baseline (source `printers`, service `printer-poller`). SSE live, no freeze. Left panel "New session", empty "Send a message to start a session", input "Message the agent — /", Send button.
- **12:30:14** — Clicked input, typed the verbatim prompt; text landed in the (auto-expanded) input field ("…weight from the dashboard." visible at tail). **Focus transfer works** — F20 resolved.
- **12:30:22** — Clicked Send. **Verbatim build prompt sent:** `Track my filament spools — material, color, weight remaining; let me add spools and update remaining weight from the dashboard.`
- **12:31:29** — Agent running. Narration shows it reasoning about the write path: mentions the surface query proxy `/data/{source}/query with {op: {kind, table, ...}}`, notes "the user wants to add spools and update remaining weight — that means the surface needs write access", plans to check `views.sql` and "how the surface query proxy handles writes (insert/update), plus how surfaces are served/registered." Emitted Read/Read/Bash. Then: "The comment in views.sql says the query DSL 'only does SELECT'. The user needs to **write** … Let me find the data proxy implementation to learn what operations (`kind`) it supports — insert/update/etc." SSE live.
- **12:32:04** — Still exploring: long stack of tool calls (many Read, Bash, Grep) building understanding of the write-back stack. Transcript auto-follows to newest (F9 OK); "thinking…" pinned. No gated action yet. SSE live.
- **12:33:00** — Plan crystallizes. Agent narration: "**printers data source is already read-write**" — it plans to **reuse the existing `printers` Postgres, NOT call `provision_database`**. TodoWrite + Read + Bash. Then: "**db/apply.js reads DATABASE_URL from env. I'll create a dedicated schema file for the spools table and view rather than editing the printer schema (keeps concerns separate), then apply it.**" Spool columns planned: material, color, weight remaining, name/brand, initial (full) weight, timestamps.
  - **WATCH-LIST (a):** so far NO `provision_database` — the agent is reusing the existing RW `printers` source rather than provisioning a new DB. No infra-queue gate expected from provisioning on this trajectory.
  - **WATCH-LIST (c) / F17 forming:** CREATE TABLE is headed for the agent's OWN ungated path — `db/apply.js` reading `DATABASE_URL` from env (its own Bash), NOT a gated provision path. Confirming next.
- **12:33:50** — **NEW dashboard tab "Filament Spools" now visible** (alongside "3D Printer Tracker") — surface registered/served. Agent explains the write path in narration:
  - "The host auto-injects a shim that wraps `window.fetch` to attach the `X-Rhumb-Surface-Token` header on any same-origin `/data/*` request. So my surface just calls `fetch('/data/printers/query' | '/data/printers/write', ...)` and auth is handled automatically. **Reads go to `/query`, writes to `/write`.**"
  - "**One thing to note: writes from an untrusted (source, surface) pair get queued (202 pending) for operator approval until trusted. I'll handle the 202 response gracefully in the UI so the user gets clear feedback the first time.**"
  - Then "Now let me build the surface." → **Write** tool call.
  - **WATCH-LIST (b) CONFIRMED:** surface issues **structured `/data/printers/write`** ops (insert/update via the data proxy), NOT raw SQL. Reads via `/data/printers/query`.
  - **Trust model surfaced by the agent:** untrusted (source, surface) writes → **queued (202 pending)** for operator approval until trusted. (This is the write-trust gate; distinct from the infra/provision gate.)
  - **New source id = `printers`** (reused existing RW source, NOT a newly provisioned one). Surface is a new surface on `printers`; capturing its id next.
- **12:34:45** — Long-running **Write** (surface HTML build). Transcript stable, "thinking…" pinned. No wedge — single in-flight Write. SSE live.
- **12:35:40** — Surface built; agent self-testing. Narration:
  - "The identity guard gates all routes (that's the 403 for my unauthenticated curl). The `.surface-token` is generated when an allowlisted user first loads the surface HTML in the browser. My curl has no identity, so it can't reach either the HTML route or the data route — that's expected and correct." (Agent ran an **unauthenticated curl → 403**, identity guard confirmed working.)
  - "I can't fully impersonate an authenticated browser session from here, but I can validate the **data-layer logic** (the risky part) directly against Postgres, exactly matching the SQL the proxy generates for my ops. That proves insert/update/delete/select round-trip correctly through the **`spool_inventory`** view. Let me do that."
  - **Table/view name = `spool_inventory`.** Agent about to validate SQL round-trip directly against Postgres (its own DB path).
- **12:36:40** — Finalization phase. Narration: "Let me verify mine parses and matches by running the exact validator, then confirm it appears in the live registry snapshot" (Bash). Then: "**The surface validates and both surfaces are discovered.** The dashboard-host scans on each registry request, so it'll appear live without a restart. Let me update todos and record the domain ontology, following the existing ontology pattern" (TodoWrite). Then reading an existing ontology file to match format and record the new entity. SSE live. No infra/provision gate has fired and none is imminent — the agent reused the RW `printers` source throughout.
- **12:37:51** — **TURN COMPLETE** (session-tab spinner gone; end-of-turn divider "Done. Your filament spool track…" rendered). Agent's final message (verbatim, the substantive tail):
  > **One thing to expect on first use** — The platform queues the **first** write from a new dashboard for operator approval (a security trust-pairing step). So the very first "Add spool" will show: *"Change queued for operator approval… It will apply once approved."* Once you approve that pending write in the control plane, this dashboard↔database pair becomes trusted and subsequent adds/updates apply immediately. If you'd like, I can point you to the exact approval command, or you can approve it when the prompt surfaces.
  (Preceded by: "…the host's registry scanner and both surfaces are discovered." The collapsed turn-summary chip reads "Done. Your filament spool track…".)
- **12:38:16** — Clicked the **"Filament Spools"** dashboard tab: surface **renders live** — header "Filament Spools · Inventory · remaining weight", green **"+ Add spool"** button, empty state "No spools yet. Click + Add spool to start your inventory." Surface is functional and served through the dashboard host. (Did NOT click "+ Add spool" — first write / trust-gate exercise belongs to the write session D4/D5, not this observe-only build turn.)

### Watch-list results (build turn)
- **(a) provision_database + auto-register read-write:** **NO `provision_database` call.** The agent reused the pre-existing `printers` source (already `read-write`) rather than provisioning a new DB. So no new source auto-registered; **new source id = `printers`** (reused). No infra/provision gate fired this turn.
- **(b) structured `/data/*` writes vs raw SQL:** **structured.** Surface calls `fetch('/data/printers/query')` for reads and `fetch('/data/printers/write')` for writes through the host's auto-injected `window.fetch` shim (adds `X-Rhumb-Surface-Token`). No raw SQL in the surface. (Agent did run raw SQL directly against Postgres *only* to self-validate the data-layer round-trip through the `spool_inventory` view — a test path, not the surface's runtime path.)
- **(c) F17 — how CREATE TABLE happened:** **ungated, agent's own path.** Agent created a dedicated schema file and applied it via `db/apply.js` (which "reads `DATABASE_URL` from env"), i.e. its own Bash/apply against the existing DB — NOT a gated `provision_database` path. Schema/DDL creation is not gated; only *runtime writes from the surface* hit the trust gate. **F17 reproduced: DDL (CREATE TABLE) is ungated; the trust gate sits at surface write-time, not schema-creation-time.**
- **(d) F8 client send-loop wedge across multi-approval:** **N/A this turn — no wedge.** Zero gated approvals occurred during the build (agent reused RW source + ungated DDL), so the multi-approval send loop was never exercised. Single prompt sent cleanly; client stayed responsive throughout (~7.5 min, dozens of tool calls streamed). No send-loop wedge observed. The multi-approval F8 path will be exercised in the write session (D4) when the first `/data/*/write` queues.
- **(e) F9 transcript follow / jump pill:** **works.** Transcript auto-followed to newest content across the entire turn (tool-call stack, narration, final message all pinned to bottom); "thinking…" stayed visible. No stuck-scroll observed.
- **(f) SSE freeze:** **none.** "3D Printer Tracker" stayed live the whole turn (updates 12:29:54 → 12:38:00, ~30s cadence). No freeze/staleness.

### New findings (F21+)
- No new client/platform *defects* surfaced this turn. F17 (ungated DDL) is **reproduced/confirmed**, not new. F8/F9 behaved. The one notable structural observation: **the write-trust gate is scoped to (source, surface) runtime writes only** — schema creation and data-source reuse are entirely ungated, so an agent can stand up a new writable surface against an existing RW source and create tables with zero operator gate; the only gate the operator ever sees is the *first surface write*. (Consistent with the coarse trust model the run is meant to document; logged here as the observed shape, not a bug.)

**IDs for D4:** new data-source id = **`printers`** (reused existing RW source; no new source created). New surface id = **`filament-spools`** (title "Filament Spools", url `/surfaces/filament-spools/`, kind `file`), backing table/view **`spool_inventory`** on source `printers`.

**Post-turn read-only checks (turn over):**
- `GET /agent/infra/pending` → `{"pending":[]}` — **infra pending empty**, consistent with no `provision_database` call this turn.
- `GET /registry` (dashboard host, read-only) → 3 entries: **`filament-spools`** (surface, file, created `2026-07-06T12:40:00Z`) ← NEW; `printer-tracker` (surface, file, 2026-07-01); `printer-poller` (service, healthy, 2026-07-02). Confirms the new surface registered live without restart.

**Turn outcome: SUCCESS.** Agent built the filament-spool tool end-to-end in a single turn (~7.5 min, 12:30:22 → 12:37:51 EDT): created `spool_inventory` schema (via its own ungated `db/apply.js`), built + registered the `filament-spools` write-back surface (structured `/data/printers/write`), self-validated the SQL round-trip, wrote ontology, and explained the first-write trust gate. No gated actions were triggered during the build (0 infra/write approvals) because it reused the RW `printers` source and DDL is ungated. The write-trust gate remains untested until the first surface write (D4). Agent's final claim that the surface works and that the first write will queue for approval is **plausible and consistent with observed registry + rendered surface**, but the actual write→202→approve→apply loop is **not yet exercised** — that is D4/D5's job to verify against ground truth.


## Phase 3 — the write session (trust ladder + adversarial probes)
## Findings
## Phase 4 — ground-truth verification
## Outcome
