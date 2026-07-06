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

**Date/TZ:** 2026-07-06, EDT. **Driver:** computer-use against packaged `Rhumb.app` (PID 24146, only Rhumb proc). **Active operator use** — curl + reading the surface's injected token are expected here, not a rescue.

### Discover-first results (replace the brief's placeholders)
- **Write target TABLE:** `filament_spools` (reads go through the `spool_inventory` view). Source: `printers` (reused RW source; no new source). Both read from the surface JS: `write({kind:"insert", table:"filament_spools", values})`, `update` with `values:{remaining_g, updated_at}, where:{id}`, `delete` with `where:{id}`; reads via `query("spool_inventory")`.
- **Insert value columns (from surface JS):** `material, color, remaining_g, color_hex, brand, name, notes` (+ `total_weight_g`).
- **Surface token source:** read from the surface's **served HTML** at `https://micropx-pve.tail731306.ts.net/surfaces/filament-spools/` — the injected shim sets it in `<meta name="rhumb-surface-token" content="…">` and the `window.fetch` wrapper (`X-Rhumb-Surface-Token`). Value is NOT persisted anywhere in this repo. (Note: the surface HTML route served 200 to an unauthenticated curl this run — the identity guard did not 403 the HTML; the token is embedded in that public HTML.)
- **Real row ids used:** id `2` = Spool One (update target), id `3` = Spool Two (DELETE probe target).

### Baseline (start of Phase 3, pre-writes)
- `GET /data/pending` (no header) → **403**; (with `Sec-Rhumb-Control: 1`) → **200 `{"pending":[]}`**. Queue empty.
- `data-trust.json` still ABSENT at start; `data-audit.jsonl` 0 lines.

### Trust ladder (via the surface UI in the client + ConfirmationDialog DATA branch)

**Rung 1 — Add spool #1, approve WITHOUT trust.**
- **12:46 EDT** — `+ Add spool` → filled MATERIAL=PLA, COLOR=Galaxy Black, BRAND=Prusament, LABEL=Spool One → Save.
- **ConfirmationDialog DATA branch rendered LIVE — first time ever.** Verbatim content (zoomed):
  - Title: **`Write to "printers"`**
  - Subtitle: **`Surface: filament-spools`**
  - JSON body:
    ```json
    {
      "kind": "insert",
      "table": "filament_spools",
      "values": {
        "brand": "Prusament",
        "color": "Galaxy Black",
        "color_hex": "#58a6ff",
        "material": "PLA",
        "name": "Spool One",
        "notes": null,
        "remaining_g": 0,
        "total_weight_g": 0
      }
    }
    ```
  - **`☐ Trust this surface`** checkbox (unchecked) · **`Deny`** / **`Approve`** buttons.
- Clicked **Approve** with the checkbox UNCHECKED. Dialog dismissed.
- **DB effect:** row `id:2` "Spool One" present in `spool_inventory` (created `2026-07-06T16:47:09.925Z`). Pending drained to `[]`. Audit line 1: `decision":"executed","rowCount":1`.
- **Result: untrusted-approve → EXECUTED.** ✅

**Rung 2 — Add spool #2, approve WITH "Trust this surface".**
- **12:47 EDT** — Add form → COLOR=Signal White, BRAND=Hatchbox, LABEL=Spool Two → Save → DATA-branch dialog rendered again (same shape, `name:"Spool Two"`).
- Clicked the **`Trust this surface`** checkbox (verified checked/blue), then **Approve** (resolve body carries `trustSurface:true`).
- **DB effect:** row `id:3` "Spool Two" present (created `2026-07-06T16:47:57Z`). Pending `[]`.
- **Trust persisted:** `data-trust.json` now = `[{"source":"printers","surfaceId":"filament-spools"}]` (was ABSENT). Audit line 2 executed.
- **Result: trust-approve → EXECUTED + pairing persisted.** ✅

**Rung 3 — Update spool #1 remaining weight (trusted → should be silent).**
- **12:48 EDT** — Spool One card → `Update weight` → "Update remaining — Spool One" modal → set REMAINING (G) = **750** → Save.
- **NO ConfirmationDialog appeared.** The card updated in place immediately (750 g, "updated 12:48:39 PM").
- **DB effect:** `spool_inventory` id:2 `remaining_g=750` (audit line 3, `update … where:{id:2}`, executed `16:48:39Z`). Pending stayed `[]`.
- **Result: trusted update → EXECUTED SILENTLY, no gate.** ✅

### Adversarial probes (curl with the surface token — active operator)

**Probe 4 — COARSENESS (post-trust DELETE).** With the surface trusted:
```
POST /data/printers/write  {"op":{"kind":"delete","table":"filament_spools","where":{"id":3}}}
→ {"status":"executed","result":{"rowCount":1}}
```
- Spool Two (id:3) **deleted immediately; NO re-gate** (pending stayed `[]`; audit line 4 `delete … executed`).
- **FINDING (coarseness confirmed):** trust is scoped to the **(source, surface) pair, NOT to op kind**. Once trusted, DELETE — the most destructive op — executes with zero operator gate, same as insert/update. The trust grant is coarse: it blesses *all* future writes from that surface, including deletes the operator never explicitly saw. `{"status":"executed"}` (not `"pending"`).

**Probe 5 — SELF-APPROVE GUARD.**
```
GET /data/pending                              → no-header:403
GET /data/pending  (Sec-Rhumb-Control: 1)      → with-header:200
```
- **PASS.** The DATA pending control plane requires the shell-only `Sec-Rhumb-Control: 1` header, which browser/page JS cannot set. A surface **cannot read or bless its own pending write** from its own page context. (Expected 403 then 200 — matched.)

**Probe 6 — IDENTIFIER WHITELIST (malformed table).** Surface trusted, so this hits inline (no queue):
```
POST /data/printers/write  {"op":{"kind":"insert","table":"bad name; drop table x","values":{...}}}
→ {"error":"write failed"}   HTTP 500
```
- **PASS.** Rows unchanged (still only id:2). Audit line 5: `decision":"error","error":"invalid identifier: bad name; drop table x"`. The `ident()` whitelist threw **before any SQL was assembled** — no malformed/injection SQL reached Postgres, and the error is recorded in the audit trail. Injection blocked at the identifier gate.

### Audit trail (data-audit.jsonl — 5 lines, was 0 at baseline)
| # | ts (UTC) | op | table | decision |
|---|---|---|---|---|
| 1 | 16:47:09 | insert Spool One | filament_spools | executed rowCount 1 |
| 2 | 16:47:57 | insert Spool Two | filament_spools | executed rowCount 1 |
| 3 | 16:48:39 | update id:2 remaining_g 750 | filament_spools | executed rowCount 1 |
| 4 | 16:49:23 | delete id:3 | filament_spools | executed rowCount 1 |
| 5 | 16:49:23 | insert (malformed table) | bad name; drop table x | **error** — invalid identifier |

Every write (including the rejected one) is audited with ts, source, surfaceId, full op, and decision. **Observability gap noted:** the audit log records only the terminal `executed`/`error` decision — it does **not** log the intermediate `pending`/enqueue nor the approve event (with/without trust). An operator reading data-audit.jsonl alone cannot tell rung-1 (approved-untrusted) from rung-2 (approved-with-trust) from rung-3 (silent, never gated); all three read identically as `executed`. The trust decision lives only in `data-trust.json`, not in the audit stream.

### Phase 3 result
Write-back loop verified end-to-end LIVE for the first time: **enqueue (202) → ConfirmationDialog DATA branch → approve → execute → audit**, across both untrusted-approve and trust-approve, plus the silent trusted path. All 3 adversarial probes behaved as designed (coarse-but-safe trust: self-approve blocked, identifier injection blocked; DELETE coverage is the documented coarseness). No client wedge/freeze; the DATA-branch dialog rendered cleanly each time and positioned within the window (the add-spool *form* modal's submit button sat at the window's bottom fold and needed the window nudged up — minor client layout nit, logged below).

## Findings

New findings from the write session (F22+):

- **F22 — Trust is per-(source,surface), not per-op-kind (coarseness, by design but sharp-edged).** Approving a single insert with "Trust this surface" checked blesses ALL subsequent writes from that surface — including DELETE (Probe 4 executed a delete with no gate). The operator who trusts a surface after seeing an *insert* dialog has implicitly authorized *deletes* they never saw. This is the documented coarse trust model; logged as the confirmed live shape. Mitigation ideas for later: show op-kinds covered at trust time, or gate destructive ops (delete/truncate) separately even for trusted surfaces.
- **F23 — Audit log omits the gate/trust decision.** `data-audit.jsonl` records only the terminal `executed`/`error` per write; it does not record the `pending` enqueue, the approve action, or whether trust was granted. Untrusted-approve, trust-approve, and silent-trusted writes are indistinguishable in the audit stream (all `executed`). Trust state is only in `data-trust.json`. An operator auditing "what was gated vs. auto-applied" cannot reconstruct it from the audit log alone.
- **F24 — Add-spool form drops the weight fields (surface bug, not platform).** The add form's FULL WEIGHT / REMAINING defaults (1000/1000) did not carry into the insert op — the dialog and DB both showed `remaining_g:0, total_weight_g:0` for both spools (hence cards read "0 g of 0 g / No full weight set"). Update-weight works (set 750 fine). This is a bug in the built surface's insert value assembly, surfaced only because the write loop now actually runs. (The trust/gate mechanics under test are unaffected.)
- **F25 — Surface HTML served 200 to an unauthenticated curl.** This run, `GET /surfaces/filament-spools/` returned the full HTML (with the embedded surface token) without any identity header — contrast the build turn where an unauthenticated curl 403'd. Worth confirming whether the surface-HTML identity guard is consistently enforced; the injected token is only as private as that HTML route. (The DATA control plane `/data/pending` correctly stayed 403 without the shell header — Probe 5.)
- **F26 (client layout nit) — add-spool form modal submit button sits at the window's bottom fold.** The add-spool *form* modal (not the ConfirmationDialog) rendered its Cancel/Save row flush at the bottom edge of the client window; the Save button was only clickable after nudging the window up. The ConfirmationDialog itself was well-centered. Minor; the taller add form overflows the default window height.

Confirmed-working (not defects): ConfirmationDialog DATA branch (first live render, correct source+surface+op JSON+trust checkbox); untrusted-approve → execute; trust-approve → execute + persist; trusted → silent execute; self-approve guard (403/200); identifier whitelist (injection blocked, audited as error); full write audit trail.

## Phase 4 — ground-truth verification
## Outcome
