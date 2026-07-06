# Dogfood run — novel-field migration + live fix-stack validation

**Date:** 2026-07-05 · **Spec:** ../superpowers/specs/2026-07-05-migration-dogfood-design.md
**Branch under test:** fix/client-chat-discovery @ 2f0f179 (PR #25+#26+#28)
**Headline claim:** redeploy_service now cleanly cuts over a real change (the day-2 orphaned-container BLOCKER, fixed).

## Phase 0 — fix-stack deploy (on-ramp friction)
## Phase 1 — baseline

### Datasource ($DB, redacted)

`$DB` = `printers` datasource, host `192.168.1.91:5432`, db `printers`, user `printers` (password redacted, not persisted).

### Schema + row counts (diff target)

| table | rows | columns (name:type) |
|---|---|---|
| `print_jobs` | 0 | id:integer, printer_id:integer, filename:text, state:text, started_at:timestamptz, finished_at:timestamptz, filament_used:double precision, total_layer:integer, current_layer:integer, print_duration:double precision, progress:double precision, created_at:timestamptz |
| `printer_status` | 2 | printer_id:integer, printer_name:text, base_url:text, printer_state:text, last_seen:timestamptz, sampled_at:timestamptz, sample_state:text, bed_temp:double precision, bed_target:double precision, nozzle_temp:double precision, nozzle_target:double precision, progress:double precision, current_layer:integer, total_layer:integer, filament_used:double precision, print_duration:double precision, active_job_id:integer, active_filename:text, active_started_at:timestamptz |
| `printers` | 2 | id:integer, name:text, base_url:text, state:text, last_seen:timestamptz, created_at:timestamptz |
| `recent_jobs` | 0 | id:integer, printer_id:integer, printer_name:text, filename:text, state:text, started_at:timestamptz, finished_at:timestamptz, filament_used:double precision, total_layer:integer, current_layer:integer, progress:double precision, print_duration:double precision |
| `recent_telemetry` | 960 | id:bigint, printer_id:integer, printer_name:text, sampled_at:timestamptz, state:text, bed_temp:double precision, nozzle_temp:double precision, progress:double precision, current_layer:integer, total_layer:integer, filament_used:double precision |
| `telemetry_samples` | 47248 | id:bigint, printer_id:integer, job_id:integer, sampled_at:timestamptz, state:text, bed_temp:double precision, bed_target:double precision, nozzle_temp:double precision, nozzle_target:double precision, progress:double precision, current_layer:integer, total_layer:integer, filament_used:double precision, print_duration:double precision |

6 tables total in `public` schema. Full raw output logged in `.superpowers/sdd/mig-runsheet.md`.

### Service baseline

- `$POLLER_CTR` = `106` (matches expectation)
- `$POLLER_IP` = `192.168.1.83`
- `$POLLER_DEPLOYID` = `20260704212359-d25440` (matches expectation)
- status: `healthy`, port `8080`, basePath `/services/printer-poller`

### Ontology node baseline (F16 diff target)

`ontology/system/service-printer-poller.md` (managed: system) currently reads:

```yaml
host: 192.168.1.238
port: 8080
status: healthy
```
```
Relationships:
- runs-on [[container-105]]
- created-by [[agent]]
```

**Drift already present before any migration turn:** the ontology service node references `container-105` / host `192.168.1.238`, while `services.json` (ground truth) has the poller on **container 106** / host `192.168.1.83`. `ontology/system/container-105.md` exists; there is no `container-106.md` node. This is a pre-existing staleness, not something Phase 2 will introduce — it's the exact shape of drift F16 is meant to catch, so it's the diff baseline: after the coming redeploy turn, verification should check whether the ontology gets corrected to reference 106, or whether it remains stuck on the now-doubly-stale 105.

Other ontology files present: `dashboard-printer-tracker.md`, `datasource-printers.md` (system); `printer-k2plus-fe91.md`, `printer-k2plus-right.md`, `print-jobs.md` (domain).

### Surface baseline

`http://127.0.0.1:8788/surfaces/printer-tracker/` → `403 {"error":"forbidden"}` (also 403 on 8787). Consistent across both dashboard ports — read as auth-gated by design, not a broken surface; recorded as-is for before/after comparison.

## Phase 2 — the turn (live log)

_All timestamps EDT (America/New_York). Operator: M4 flight-recorder via Tauri client GUI (computer-use). F-numbering continues from F16 (Phase 0/1), so provisional findings start at F17._

- **21:55:46** — request_access granted for Rhumb (full tier). Client PIDs confirmed alive: dev-build `target/debug/app` **89419**, tauri **89195**, vite **89391**, npm **89176**. Note: a *separate* installed `Rhumb.app` (PID 88651) is also running — the dev build (89419) is the one under test; brought it to front via its dock icon.
- **21:56:36** — Window confirmed on the sessions view and **connected/live**. Right panel "3D Printer Tracker" shows green **live · updated 9:56:36 PM**. Two printers: K2Plus-FE91 (nozzle 25.4°C / bed 23.4°C, Standby, No active print) and K2Plus-Right (nozzle 25.2°C / bed 24.1°C, Standby). Left sidebar "No sessions yet." Message composer present ("Message the agent — / for commands" + Send). No manual reconnect needed — F14 autodiscovery not exercised.

- **21:57:16** — **SEND.** Prompt sent verbatim: `Track the hottest nozzle and bed temperature reached during each print job, and show it on the dashboard.` Single click on Send registered immediately; user bubble rendered, session tab renamed "Track the hottest nozzl…" with blue activity dot, agent status → **thinking…**, composer cleared. (Watch-c/F8: send registered on first click — no wedge at send.)

- **21:57:56** — Agent replied "I'll help track nozzle and bed temperatures during print jobs. Let me first explore the codebase…" then ran a long read-only exploration chain (Task, ~7×Bash, ~8×Read, 2×Glob) — still **thinking…**. Transcript auto-follows the live edge; newest calls + thinking indicator visible with **no jump-to-latest pill needed** (Watch-d/F9: following cleanly). No pending/gated actions yet.

- **~21:58–22:00** — Extended read-only exploration (~2.5 min, dozens of Read/Bash/Glob). Agent narration surfaced in transcript: "This is a legitimate 3D printer monitoring tool (not malware). I now have full understanding." Then "The implementation mirrors the existing `filament_used` peak-tracking pattern using `GREATEST()`." → **TodoWrite** (plan).
- **22:00:22** — Agent begins implementation. Notable, correct reasoning captured verbatim: "Note the schema uses `CREATE TABLE IF NOT EXISTS`, so for an existing DB I need `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` to actually add the columns." → **Edit** (schema) → TodoWrite → "Now update the poller. I'll follow the existing `GREATEST()` pattern used for `filament_used`. Peak temps should update on every sample while the job is open (including the opening sample), and be preserved on close." → thinking. **Non-destructive ALTER approach — no DROP/TRUNCATE planned.** Live telemetry still updating (SSE healthy, Watch-f OK). No gated pending action yet.

- **22:02:12** — Code changes complete (schema.sql ALTER, poller GREATEST peak-tracking incl. closeJob "only ever raise the stored max", recent_jobs + printer_status views, dashboard card peak line, Recent Jobs Peak Nozzle/Peak Bed columns). Agent then: "Now apply the schema migration… The `apply.js` script runs `schema.sql`… then I'll apply `views.sql`." → **Bash** ("Schema applied.") → **Bash** ("Now apply the views.") → thinking.
  - **F17 (provisional, low/informational):** The DB schema+views migration was applied by the agent **directly over Bash via its own `apply.js` script — it did NOT surface a gated pending-approval action in the client UI.** So the "approve via client pending UI" path was not exercised for the DB apply (the migration is non-destructive ALTER…IF NOT EXISTS, so no data-loss risk). Whether DB apply *should* be gated is a policy question for M5; recording that on this turn it wasn't operator-gated.

- **22:03:07** — Agent verified columns via Bash ("All columns are in place. Database migration is complete." → TodoWrite), then: "Now redeploy the poller service so the new lifecycle SQL takes effect. Let me check the current service registry first." → **mcp__infra__list_services** → "The poller is a registered service — I'll blue-green redeploy it. The dashboard surface is static HTML served by the platform; redeploying the poller handles the backend." → **mcp__infra__redeploy_service**.
  - **Watch-a CONFIRMED ✅:** agent called **`redeploy_service`** (NOT `spawn_service`), passing the correct existing id. This is the exact fix under validation.
- **22:03:17** — **GATED ACTION #1 appeared.** Modal title "**Infrastructure: redeploy_service**", payload verbatim `{ "id": "printer-poller" }`, buttons **Deny / Approve**. Non-destructive redeploy of an existing service (not a DROP/TRUNCATE) → decision: **APPROVE**.

- **22:03:37** — Clicked **Approve**. Modal dismissed instantly; transcript shows `mcp__infra__redeploy_service` executing; agent status → thinking (redeploy in progress). Approval click registered on first press — no wedge (Watch-c/F8 OK across the approval). Live telemetry still flowing (10:03:32 PM). Now watching for the cutover outcome (Watch-b).

- **~22:05:13** — **AGENT COMPLETED.** Redeploy returned and agent emitted its final "## What changed / ## Deployment" summary; session activity dot cleared (idle). Total turn ≈ 8 min (22:57:16 send → 22:05:13 done).
  - **Watch-b (cutover) ✅:** Deployment section states verbatim: **"Blue-green redeployed `printer-poller` (now healthy on container 105)."** — reports a CLEAN, healthy cutover with **no orphaned-container warning** (contrast: day-2 BLOCKER left an orphan). This is the primary fix validated as working *from the client's vantage*.
  - **Note for M5 (ground truth):** agent claims the poller is now healthy on **container 105**. Baseline (M2) had the poller on **container 106** @ 192.168.1.83. If literally true, the redeploy cut to a *different* container id than baseline — M5 must reconcile whether "105" is (a) the agent misreporting, (b) the new blue-green target id, or (c) a real cutover to 105. Also note the pre-existing ontology drift (F16) referenced 105 — coincidental match worth checking. NOT verified this turn (box interaction forbidden).

### Agent's verbatim final claim (load-bearing excerpt)

> **## Deployment**
> - Applied `schema.sql` and `views.sql` to the `printers` database and verified all six new columns exist.
> - Blue-green redeployed `printer-poller` (now healthy on container 105).
> - The dashboard is a static file surface served from the workspace, so the edited HTML is already live.
>
> Peak values populate going forward. Jobs already finished before this change will show "—" since their peaks weren't recorded; new and in-progress jobs will fill in as the poller samples them.

(Trailing session-summary chip, truncated in UI: "Done. Each print job now tracks the hottest nozzle and…")

### Watch-list summary (a–f)

- **(a) redeploy_service vs spawn_service — ✅ PASS.** Agent called `mcp__infra__redeploy_service` with `{ "id": "printer-poller" }` on the existing service. Never touched `spawn_service`. The exact fix under test was exercised correctly.
- **(b) clean cutover vs warning — ✅ PASS (per client).** Agent reported "now healthy on container 105", no orphan/warning. (Ground-truth container reconciliation deferred to M5; see note above.)
- **(c) client SEND / approval responsiveness (F8 wedge) — ✅ NO WEDGE.** Send registered on first click (22:57:16); Approve registered on first click and dismissed the modal instantly (22:03:37). No dropped/ignored clicks anywhere in the turn.
- **(d) transcript follow / jump pill (F9) — ✅ FOLLOWED.** Transcript auto-followed the live edge throughout the ~8-min stream of dozens of tool calls; the jump-to-latest pill was never needed. (One nuance: at the very end the message pane appeared to stop scrolling at the top of the final "## What changed" block rather than pinning the last line — but the whole final message was reachable and no pill appeared; not a defect, logged for completeness.)
- **(e) dead AskUserQuestion bounce (F7) — ✅ N/A / not triggered.** Agent never emitted an AskUserQuestion; it proceeded autonomously through explore→implement→migrate→redeploy. The only interactive gate was the single redeploy_service approval, which rendered and functioned correctly.
- **(f) SSE staleness / transcript freeze — ✅ NONE.** Right-panel live telemetry updated continuously (9:56 → 10:05 PM, ~30s cadence) including *through* the blue-green redeploy window; no freeze, no stale-connection banner. Transcript streamed tool calls in real time.

### Gated actions this turn

| # | time appeared | tool | payload | decision | time resolved | UI behavior |
|---|---|---|---|---|---|---|
| 1 | 22:03:17 | `redeploy_service` (Infrastructure) | `{ "id": "printer-poller" }` | **Approve** | 22:03:37 | Modal rendered cleanly with Deny/Approve; Approve dismissed it instantly, tool executed, no wedge |

**Total gated actions surfaced in client UI: 1** (the DB schema/views apply was NOT gated — applied directly via agent Bash/`apply.js`; see F17).

- **22:06:16** — Post-turn read-only check (the one allowed): `GET /agent/infra/pending` → `{"pending":[]}`. **Pending queue empty** — no orphaned/unresolved gated action after the redeploy. Turn declared **OVER**.

## Findings

Provisional findings from Phase 2 (severity is the flight-recorder's read; confirm/reclassify in M5):

- **F17 — DB schema/views migration bypasses the client approval gate (informational / low).** The `ALTER TABLE … ADD COLUMN` + view-recreate migration ran via the agent's own `apply.js` over plain Bash and never surfaced a pending-approval modal in the client. Only the `redeploy_service` call was operator-gated. On this turn the migration was non-destructive (IF NOT EXISTS), so no data-loss exposure — but a *destructive* schema change would likewise not be operator-gated under the current tool routing. Policy question for M5: should DB apply route through the infra gate the way redeploy does?
- **F18 — agent reports poller "healthy on container 105" but baseline was 106 (needs ground-truth; sev TBD).** The redeploy self-report names container **105**; M2 baseline had the poller on **106** @ 192.168.1.83, and the ontology node (F16) is already stale on 105. Three possibilities (agent misreport / new blue-green target id / real cutover to 105) can't be told apart from the client. If the live poller is genuinely on a *different* container than baseline with 106 left behind, that would be a redeploy-cutover regression of the exact day-2 shape — so this is the #1 item for M5 to resolve. Flagged, not concluded.
- **No F-number: primary fix VALIDATED (from client vantage).** `redeploy_service` was called correctly on the existing id, the modal gated it, approval executed cleanly, the agent reported a healthy blue-green cutover, and the pending queue drained to empty with no orphan warning. The day-2 BLOCKER symptom (half-completed redeploy + orphaned container + stuck queue) did **not** reproduce in the client-observable surface. Ground-truth container/DB/telemetry confirmation is M5's job.
- **Client behavior: clean.** No F8 send/approve wedge, no F9 jump-pill need, no F7 dead AskUserQuestion, no SSE freeze. Live telemetry stayed green throughout including across the redeploy.

## Phase 3 — ground-truth verification

_Operator: M5 ground-truth pass via direct SSH to `root@micropx-pve.tail731306.ts.net` (trusted box), read-only only (SELECT/information_schema, cat, ls, systemctl status, journalctl, pct list/config/exec read-only). No mutations. All commands and raw output below are pasted verbatim (creds redacted)._

### C1 — CLEAN CUTOVER (headline, F11/F18) — **PASS**

`pct list` (full, unfiltered):

```
VMID       Status     Lock         Name
101        running                 molding-harvester
102        running                 rhumbr-test
103        stopped                 erpnext
105        running                 rhumb-printer-poller
```

**Exactly one** `rhumb-printer-poller` container exists: **105**. Baseline **106 is absent** from `pct list` — not stopped, not present at all, no orphan.

`services.json` registry:
```json
{
  "id": "printer-poller", "containerId": 105, "host": "192.168.1.34", "port": 8080,
  "status": "healthy", "deployId": "20260706020334-f4ecfe",
  "updatedAt": "2026-07-06T02:04:16.033Z"
}
```

Three-way provenance (all match):
- Registry `deployId`: `20260706020334-f4ecfe`
- Container `.rhumb-deploy.json` (`pct exec 105 -- cat /opt/rhumb/printer-poller/.rhumb-deploy.json`): `{"deployId":"20260706020334-f4ecfe","deployedAt":"2026-07-06T02:04:09.546Z"}`
- Unit env (`pct exec 105 -- systemctl cat rhumb-printer-poller | grep DEPLOY_ID`): `Environment=RHUMB_DEPLOY_ID=20260706020334-f4ecfe`

`systemctl show -p NRestarts rhumb-printer-poller` → **`NRestarts=0`** (not a crash loop; day-2 was ~500). `systemctl status` shows `Active: active (running) since 2026-07-06 02:04:10 UTC`, PID stable, log lines `printer-poller starting… health server on :8080`, no restart churn. Container IP (`192.168.1.34`, confirmed via `pct exec 105 -- ip -4 addr show eth0`) matches the registry `host` field exactly.

**Creation-time proof — container 105 is genuinely NEW, not adopted (refutes the day-2 orphan-adoption shape):**

```
# /etc/pve/lxc/105.conf mtime: 2026-07-05 22:03:36 EDT (= 02:03:36 UTC)
# pct exec 105 -- stat /etc  → rootfs birth (%w): 2026-07-06 02:03:35 UTC
# registry/container/unit deployId: 20260706020334-f4ecfe  (= 02:03:34 UTC)
```

Container 105's rootfs was **born at 02:03:35 UTC — one second after the deployId (02:03:34 UTC)** — so it was freshly provisioned *during this redeploy*, not silently adopted from a pre-existing container. CTID **105 is a recycled id** (Proxmox reused a freed low CTID after 106 and earlier containers were destroyed), but the container now occupying that id is brand new, proven by its rootfs birth-time landing inside this turn's window. This refutes the day-2 "silently-adopted orphan" hypothesis with independent **creation-time** evidence — orthogonal to the deployId match (birth-time comes from the filesystem, deployId from three config legs), so C1 no longer rests on the deployId string alone.

**F18 resolved:** the agent's self-reported "105" was correct and is **not** a stale/recycled reference to the pre-existing ontology drift — it is the genuine new blue-green target, freshly created within the turn window and cryptographically tied to the new deployId on all three legs (registry/container-file/unit-env). CTID 106 was retired cleanly (blue-green cut over, old container torn down, not left orphaned/crash-looping). This is the opposite of the day-2 shape: day-2 left a second, unregistered container running; here there is exactly one, it was created *during* this redeploy, and it is the one the registry points at.

### C2 — migration landed — **PASS**

Schema query (read-only Node script using the poller's own `pg` client library, no mutation, run against `information_schema.columns`) shows on `jobs`-family tables:
- `print_jobs`: new `max_nozzle_temp` (double precision), `max_bed_temp` (double precision) — added to the original 12 columns, nothing removed/changed.
- `recent_jobs`: same two new columns added, nothing else changed.
- `printer_status`: new `active_max_nozzle_temp`, `active_max_bed_temp` (double precision).

Live code check (`pct exec 105 -- grep -iE "max|GREATEST|Math.max" /opt/rhumb/printer-poller/index.js`) confirms running-max logic is deployed on container 105, e.g.:
```
max_nozzle_temp = GREATEST(COALESCE($8, max_nozzle_temp), COALESCE(max_nozzle_temp, $8)),
max_bed_temp = GREATEST(COALESCE($9, max_bed_temp), COALESCE(max_bed_temp, $9)),
```
present in both the insert-on-open and update-on-close code paths — matches the M4 transcript's described `GREATEST()` peak-tracking pattern, and it's running on the *live* container, not just checked into source.

### C3 — data preserved — **PASS**

All 6 baseline tables present, none truncated:

| table | baseline rows | now | delta |
|---|---|---|---|
| `print_jobs` | 0 | 0 | unchanged |
| `printer_status` | 2 | 2 | unchanged |
| `printers` | 2 | 2 | unchanged |
| `recent_jobs` | 0 | 0 | unchanged |
| `recent_telemetry` | 960 | 960 | unchanged |
| `telemetry_samples` | 47248 | **47494** | **+246, climbing** |

`telemetry_samples` ≥ baseline and actively growing (poller has been sampling since the 02:04 UTC redeploy) — confirms continuous operation post-cutover, not a fresh/empty replacement DB.

### C4 — F16 auto-sync — **PASS (drift corrected)**

Pre-turn baseline (Phase 1): `service-printer-poller.md` → `host: 192.168.1.238`, relationship `runs-on [[container-105]]` — **already stale** before this turn (ground truth was 106/192.168.1.83 at the time).

Post-turn read:
```yaml
host: 192.168.1.34
port: 8080
status: healthy
updated: 2026-07-06T02:04:17.589Z
```
`runs-on [[container-105]]`

The node now points at **192.168.1.34** — the actual live container's IP (confirmed identical to `pct exec 105 -- ip addr` and to `services.json.host`) — and `updated` timestamp (`02:04:17.589Z`) lands 8 seconds after the deploy's `.rhumb-deploy.json` timestamp (`02:04:09.546Z`).

**Proof the correction was AUTOMATIC (onMutate), not a manual `ontology_sync` call during the turn:**
- A grep of the full Phase-2 turn log + M4 report for `ontology_sync` / `sync_ontology` returns **ZERO matches**. The agent's only infra tool call was the gated `redeploy_service`; its only other box action was the DB apply via Bash (F17). **No ontology-sync tool call appears anywhere in the transcript.**
- The `onMutate` hook was confirmed **deployed** in `dist/infra/server.js` at M1 (runsheet Step 5: `onMutate` count = 1) — it fires `ontologyOps.sync()` on `redeploy_service` success.
- Combining the two: with no manual sync call in the transcript *and* the onMutate hook present and firing on the redeploy, the correction came from the **automatic onMutate path**. The 8-second-after-deploy `updated` timestamp corroborates this rather than being the sole basis — the claim now rests on "no sync call in the transcript + onMutate deployed," not timestamp proximity alone.

The relationship label `container-105` was already correct only by coincidence — the pre-existing stale node happened to name the same CTID that the recycled-id cutover landed on (see C1: 105 is a recycled id occupied by a brand-new container, proven by rootfs birth-time). The **host/IP field — the part that was actually wrong (`192.168.1.238`) — got corrected automatically to `192.168.1.34`**. F16 fired and fixed the drift; nothing manual was run.

**On C1↔C4 circularity:** the earlier draft risked circularity (C1 and C4 each implicitly assuming 105 was "new"). C1 now stands on independent **creation-time** evidence (rootfs birth 02:03:35 UTC), so C4's "coincidental container-105 label" note is grounded, not assumed: the stale node's CTID happened to match the recycled id, while the IP was the real drift that onMutate auto-corrected.

### C5 — F7/F8/F9 (restated from M4 log, no new box work) — **PASS (all three)**

- **F7 (dead AskUserQuestion):** N/A/PASS — agent never emitted one; proceeded autonomously start to finish (M4 log, no timestamp needed — absence confirmed across full transcript).
- **F8 (send/approve wedge):** PASS — Send registered first-click at 21:57:16; Approve registered first-click and dismissed instantly at 22:03:37. No dropped clicks anywhere in the ~8 min turn.
- **F9 (transcript follow/jump pill):** PASS — transcript auto-followed the live edge across dozens of tool calls, 21:57:56→22:05:13; pill never needed (minor cosmetic nuance at the very final message noted in M4, not a defect).

### C6 — surface — **PASS**

From this Mac, over the tailnet (real identity, not loopback):
```
$ curl -s -o /dev/null -w '%{http_code}\n' https://micropx-pve.tail731306.ts.net/surfaces/printer-tracker/
200
$ curl -s https://micropx-pve.tail731306.ts.net/surfaces/printer-tracker/ | grep -ci 'nozzle\|bed\|temp'
30
```
Box loopback (`ssh … curl 127.0.0.1:8788/surfaces/printer-tracker/`) → `403` — this is the tailnet-identity gate from Phase 1 baseline, not breakage (baseline was also 403 on loopback; consistent, expected).

Body inspection confirms the surface renders: each printer card shows a `peak {temp}°C` line under nozzle and bed readings (`peakLine(p.active_max_nozzle_temp)`, `peakLine(p.active_max_bed_temp)`), and the Recent Jobs table has dedicated `Peak Nozzle` / `Peak Bed` columns (`<th>Peak Nozzle</th><th>Peak Bed</th>`) — the new feature is live and visually present on the dashboard, not just in the DB.

### Overall verdict: **PASS**

All 6 criteria pass with pasted, cross-checked evidence. **C1 (headline) is clean**: exactly one poller container (105), registry/container-file/unit-env deployId all agree, NRestarts=0, old container 106 fully absent (not orphaned, not crash-looping) — the redeploy cut over correctly. F18 is resolved: "105" was the genuine new target, not a misreport and not the day-2 stale ontology reference (that was IP-only drift, now corrected). C4 shows F16's auto-sync actively fixed the pre-existing ontology staleness during this turn, without any manual `ontology_sync` call. C2/C3 confirm the feature is real (schema + live code + rendered surface) and no data was lost or truncated. C5 reconfirms clean client behavior from M4. C6 confirms the surface is reachable and shows the new peak-temp feature end to end.

**Plumbing-at-idle caveat:** printers were idle (Standby, no active job) throughout Phase 2/3, so `active_max_nozzle_temp`/`active_max_bed_temp` on the currently-live `printer_status` rows may read `NULL`/0 until a real print job runs — this is expected idle-state behavior, not a defect, and does not affect any PASS verdict above (schema, code, and historical `telemetry_samples` growth are all independently confirmed).

**Day-2 BLOCKER status: STAYED FIXED.** The day-2 failure shape (redeploy claims success but leaves an orphaned/unregistered second container alive) did **not** reproduce. `pct list` shows exactly one poller container, and it is the one the registry, the container's own deploy manifest, and the running unit's environment all agree on. The fix stack (F11/F12/F16 territory) holds under this real-world validation turn.

## Outcome
