# Day-2 Dogfood Run Plan — Filament Tracking on the Live Printer Tracker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the approved day-2 dogfood (spec: `docs/superpowers/specs/2026-07-04-day2-dogfood-filament-design.md`) — one compound gated turn that adds filament tracking to the live printer tracker, driven from the Tauri client, with ground-truth verification and a committed findings doc.

**Architecture:** This is an *operational run plan*, not a code plan — the platform's build agent writes whatever code the change needs. Our tasks are: bring the box to current main, snapshot the baseline, drive one turn from the client, verify ground truth against the baseline, and write findings. Box-specific values (unit names, paths, connection strings) are discovered in Task 1 and recorded in the run log; later tasks reference them as shell variables.

**Tech Stack:** SSH to the PVE box, `node` + `pg` (from the deployed agent-host's `node_modules` — the box has no `psql`), `curl`, the Tauri client (`npm run tauri:dev` in `client/`), `systemctl`/`journalctl`.

## Global Constraints

- **Observe, don't rescue.** During the turn (Task 4) issue NO manual commands against the box, containers, or DB. If the agent stalls or fails, that is the finding. Manual intervention is allowed only after the turn is declared over.
- **Findings drive the roadmap** — the run log records every friction point as an F-numbered finding with severity; the write-up (Task 6) ranks them.
- **Client bugs get filed, not fixed mid-run.** If the client blocks a step, fall back to raw HTTP for that step (commands in Task 4) and record the client failure as a finding.
- **Box:** `micropx-pve.tail731306.ts.net` (`$BOX`), SSH as root. Tailscale serve fronts both hosts: dashboard at `https://$BOX/`, agent at `https://$BOX/agent`. Direct ports on the box: agent `127.0.0.1:8787`, dashboard `127.0.0.1:8788`.
- **Run log:** all outputs and timestamps are pasted into `docs/dogfood/2026-07-04-day2-filament.md` as you go (created in Task 2, committed in Task 6). Timestamps in local time, `date '+%H:%M:%S'`.

---

### Task 1: Box discovery + update to current main (spec Phase 0)

**Files:**
- None in this repo (all work is on the box). Outputs recorded for the run log.

**Interfaces:**
- Produces (recorded values used by every later task): `$REPO_DIR` (deployed repo path on box), `$WS` (RHUMB_WORKSPACE path on box), agent/dashboard systemd unit names, `$TOKEN` (RHUMB_CONTROL_TOKEN value), `$DEPLOY_KEY` (RHUMB_DEPLOY_KEY path).

- [ ] **Step 1: Start the Phase-0 timer and note the step count rule**

Every discrete manual command below counts as one "on-ramp step." Record start time:

```bash
date '+%H:%M:%S'
```

- [ ] **Step 2: Discover the deployed stack layout**

```bash
ssh root@micropx-pve.tail731306.ts.net "systemctl list-units --all --no-pager | grep -i rhumb"
```

Expected: two units (agent host + dashboard host; names contain `rhumb`). Record the exact unit names as `$AGENT_UNIT` and `$DASH_UNIT`. Then for each:

```bash
ssh root@micropx-pve.tail731306.ts.net "systemctl cat $AGENT_UNIT"
```

Record from the unit file / EnvironmentFile: `WorkingDirectory` → `$REPO_DIR` (repo root is its parent if WorkingDirectory points at `agent-host/`), `RHUMB_WORKSPACE` → `$WS`, `RHUMB_CONTROL_TOKEN` → `$TOKEN`, `RHUMB_DEPLOY_KEY` → `$DEPLOY_KEY`. If the env lives in a separate file, `cat` it.

- [ ] **Step 3: Confirm current deployed revision (expect PR #21-era, behind main)**

```bash
ssh root@micropx-pve.tail731306.ts.net "cd $REPO_DIR && git log --oneline -1 && git status --short"
```

Expected: HEAD at or near `93081f0` (PR #21 merge), clean tree. If the tree is dirty, record what's dirty in the run log before proceeding (do not discard silently).

- [ ] **Step 4: Update to current main**

```bash
ssh root@micropx-pve.tail731306.ts.net "cd $REPO_DIR && git fetch origin && git checkout main && git pull --ff-only && git log --oneline -1"
```

Expected: HEAD = `adce272` (merge of PR #23) or newer.

- [ ] **Step 5: Rebuild both hosts**

```bash
ssh root@micropx-pve.tail731306.ts.net "cd $REPO_DIR/agent-host && npm ci && npm run build"
ssh root@micropx-pve.tail731306.ts.net "cd $REPO_DIR/dashboard-host && npm ci && npm run build"
```

Expected: both builds exit 0. Record wall time of each.

- [ ] **Step 6: Restart and health-check**

```bash
ssh root@micropx-pve.tail731306.ts.net "systemctl restart $AGENT_UNIT $DASH_UNIT && sleep 3 && curl -s http://127.0.0.1:8787/healthz && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/"
```

Expected: `{"ok":true}` and `200`. If the agent host refuses to start, check `journalctl -u $AGENT_UNIT -n 50` — the likely cause is a new required env var introduced since PR #21 (that itself is a finding: record it).

- [ ] **Step 7: Stop the timer; record the Phase-0 friction finding**

Record: end time, total steps, anything that wasn't mechanical. This feeds the standing "on-ramp / deploy.sh" roadmap signal from run 1.

---

### Task 2: Baseline snapshot (spec Phase 1)

**Files:**
- Create: `docs/dogfood/2026-07-04-day2-filament.md` (run log; grows through Tasks 2–5, finalized in Task 6)

**Interfaces:**
- Consumes: `$REPO_DIR`, `$WS` from Task 1.
- Produces: `$DB` (printers datasource connection string), `$POLLER_HEALTH` (poller health URL), `$CTR_IP`/`$CTR_ID` (poller container), baseline table/count/schema listing pasted in the run log.

- [ ] **Step 1: Create the run log with the baseline skeleton**

Create `docs/dogfood/2026-07-04-day2-filament.md` locally:

```markdown
# Dogfood run — day-2: filament tracking on the live printer tracker

**Date:** 2026-07-04 · **Spec:** ../superpowers/specs/2026-07-04-day2-dogfood-filament-design.md
**Claim under test:** Rhumb can modify a tool it built — schema migration with live data, service redeploy, surface update — in one gated turn, driven from the client.

## Phase 0 — box update (on-ramp friction)
<!-- steps, wall time, surprises -->

## Phase 1 — baseline
<!-- table counts, schema, poller health, surface status, ontology entries -->

## Phase 2 — the turn (live log)
<!-- timestamped observations; every friction point tagged F# -->

## Findings
<!-- F1..Fn, severity, action -->

## Phase 3 — ground-truth verification
<!-- pass/fail per spec criterion 1–5 -->

## Outcome
```

- [ ] **Step 2: Extract the printers datasource connection**

```bash
ssh root@micropx-pve.tail731306.ts.net "cat $WS/data-sources.json"
```

Record the printers entry's id and connection string → `$DB`. (Do NOT paste the password into the run log — record host/db/user only.)

- [ ] **Step 3: Snapshot table counts and schema**

Run via the deployed agent-host's `pg` (no `psql` on the box — finding F2 from run 1):

```bash
ssh root@micropx-pve.tail731306.ts.net "cd $REPO_DIR/agent-host && DB='$DB' node -e '
const {Client}=require(\"pg\");
(async()=>{const c=new Client({connectionString:process.env.DB});await c.connect();
const t=await c.query(\"select table_name from information_schema.tables where table_schema='\''public'\'' order by 1\");
for(const r of t.rows){
  const n=await c.query(\`select count(*)::int as n from \"\${r.table_name}\"\`);
  const cols=await c.query(\"select column_name,data_type from information_schema.columns where table_schema='\''public'\'' and table_name=\$1 order by ordinal_position\",[r.table_name]);
  console.log(r.table_name, n.rows[0].n, JSON.stringify(cols.rows));
}
await c.end();})().catch(e=>{console.error(e.message);process.exit(1)})'"
```

Expected: ~3 tables (printers / jobs / telemetry, whatever run 1 named them), telemetry count in the high hundreds+. Paste the full output into the run log's Phase 1 section — this is the data-preservation reference.

- [ ] **Step 4: Snapshot service + surface + ontology state**

```bash
ssh root@micropx-pve.tail731306.ts.net "cat $WS/services.json"
```

Record the poller entry: service name, container id (`$CTR_ID`, expected 105), container IP (`$CTR_IP`), health URL (`$POLLER_HEALTH`), status (expected `healthy`). Then:

```bash
ssh root@micropx-pve.tail731306.ts.net "curl -s $POLLER_HEALTH; curl -s -o /dev/null -w ' surface:%{http_code}\n' http://127.0.0.1:8788/surfaces/printer-tracker/"
ssh root@micropx-pve.tail731306.ts.net "ls $WS/ontology && grep -ril printer $WS/ontology | sort"
```

Expected: poller `{"ok":true,...}`, `surface:200`, ontology files including `datasource-printers`, `service-printer-poller`, `container-105`, `dashboard-printer-tracker`. Paste all into the run log.

- [ ] **Step 5: Commit the run log skeleton**

```bash
git add docs/dogfood/2026-07-04-day2-filament.md
git commit -m "docs(dogfood): day-2 run log — phase 0/1 baseline"
```

---

### Task 3: Client launch + connection (spec Phase 2 prep)

**Files:**
- None modified. Client runs from this checkout: `client/`.

**Interfaces:**
- Consumes: `$TOKEN` from Task 1.
- Produces: a connected client session against `https://micropx-pve.tail731306.ts.net` with the sessions panel populated.

- [ ] **Step 1: Launch the client**

```bash
cd client && npm ci && npm run tauri:dev
```

Expected: Tauri window opens to the connection screen (first Rust build ~4 min if cold).

- [ ] **Step 2: Connect over tailnet identity**

In the connection screen use the serve origin (agent base `https://micropx-pve.tail731306.ts.net/agent`, dashboard base `https://micropx-pve.tail731306.ts.net`) and `$TOKEN` as the control token — or the zero-entry/autodiscovery path if offered (PR #21 feature; prefer it, and record whether it worked).

Expected: shell loads, sessions panel lists existing sessions (index backfill from PR #23 should show prior on-disk transcripts — record whether it does).

- [ ] **Step 3: Verify the pending-actions surface is reachable**

Open the pending-actions UI in the client; it should be empty. Cross-check raw:

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://micropx-pve.tail731306.ts.net/agent/infra/pending
```

Expected: `{"pending":[]}`. Any discrepancy between client UI and raw endpoint is a finding.

---

### Task 4: The compound turn (spec Phase 2)

**Files:**
- Modify: `docs/dogfood/2026-07-04-day2-filament.md` (live log only — no repo code changes; the build agent changes code on the box/containers)

**Interfaces:**
- Consumes: connected client (Task 3), baseline (Task 2).
- Produces: completed turn + timestamped observation log with F-numbered findings.

- [ ] **Step 1: Start a new chat session and send the prompt, verbatim**

```
The printer tracker should track filament usage. Add per-job filament used
(Moonraker exposes print_stats.filament_used), keep it in job history, and
show it on the dashboard.
```

Record send time.

- [ ] **Step 2: Observe; approve gated actions through the client's pending-action UI**

Rules of engagement:
- Read each pending action fully before approving. Approve everything reasonable — the test is the platform, not our caution. Deny only if an action would destroy baseline data (e.g. `DROP TABLE` on a populated table without a backup step); a deny is itself a rich finding.
- Log every event with a timestamp: gated action appeared / approved, agent decision points, retries, stalls, errors, anything from the watch-list (migration improvisation, existing-service redeploy path, multi-confirmation UI behavior, `AskUserQuestion` misuse).
- **No manual commands against box/DB/containers** until the turn is declared over.

Raw-HTTP fallback (ONLY if the client's pending UI fails — record as a client finding):

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://micropx-pve.tail731306.ts.net/agent/infra/pending
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"decision":"approve"}' https://micropx-pve.tail731306.ts.net/agent/infra/pending/<ID>/resolve
```

> **STALE (kept for the historical record):** identity mode requires the `Sec-Rhumb-Control: 1` shell header instead of Bearer auth — this recipe 403s against a current deployment. See "Driving and approving over HTTP" in `agent-host/README.md`. Discovered as a finding during the run this plan drove.

- [ ] **Step 3: Declare the turn over**

The turn ends when the agent reports completion, or is stuck with no forward progress for ~15 minutes, or has plainly failed. Record end time and the agent's own final claim (we check it against ground truth in Task 5 — run 1 showed self-reports can be trusted but must be verified).

---

### Task 5: Ground-truth verification (spec Phase 3)

**Files:**
- Modify: `docs/dogfood/2026-07-04-day2-filament.md` (Phase 3 section: pass/fail per criterion)

**Interfaces:**
- Consumes: baseline outputs (Task 2), `$DB`, `$POLLER_HEALTH`, `$CTR_IP`, `$DEPLOY_KEY`.
- Produces: verdict per spec criterion 1–5.

- [ ] **Step 1: Criterion 1 — data preserved**

Re-run the Task 2 Step 3 counts/schema command unchanged. Pass: every baseline table still present; every baseline count ≥ its Phase-1 value (telemetry should have grown); no baseline column dropped.

- [ ] **Step 2: Criterion 3 — new field live**

In the same output, confirm a new filament column exists (on the jobs/history table) with a numeric type. Then:

```bash
ssh root@micropx-pve.tail731306.ts.net "cd $REPO_DIR/agent-host && DB='$DB' node -e '
const {Client}=require(\"pg\");
(async()=>{const c=new Client({connectionString:process.env.DB});await c.connect();
const r=await c.query(process.env.Q);console.log(JSON.stringify(r.rows,null,1));await c.end();})()
.catch(e=>{console.error(e.message);process.exit(1)})' " 
```

with `Q` set to a select of the newest few rows of the filament-bearing table (exact table/column names come from the schema diff — record the query used). Pass: column populated (0 is legitimate — printers idle; note whether a real print ran during the window).

- [ ] **Step 3: Criterion 2 — service healthy, hands-off**

```bash
ssh root@micropx-pve.tail731306.ts.net "curl -s $POLLER_HEALTH && cat $WS/services.json"
ssh root@micropx-pve.tail731306.ts.net "ssh -i $DEPLOY_KEY -o StrictHostKeyChecking=no root@$CTR_IP 'systemctl is-active printer-poller 2>/dev/null || systemctl list-units --no-pager | grep -i poller'"
```

Pass: health `{"ok":true,...}`, registry `healthy`, unit `active`, **and** the Task 4 log shows zero manual interventions. Also check for restart storms since the turn started:

```bash
ssh root@micropx-pve.tail731306.ts.net "ssh -i $DEPLOY_KEY root@$CTR_IP 'journalctl -u printer-poller --since \"<turn start time>\" | grep -c Started'"
```

Expected: small number (one redeploy restart is normal; dozens = crash loop finding).

- [ ] **Step 4: Criterion 4 — surface renders the field**

```bash
ssh root@micropx-pve.tail731306.ts.net "curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/surfaces/printer-tracker/ && curl -s http://127.0.0.1:8788/surfaces/printer-tracker/ | grep -ci filament"
```

Pass: `200` and grep count ≥ 1. Also eyeball the rendered dashboard in a browser / the client canvas and record a sentence on what it actually shows.

- [ ] **Step 5: Criterion 5 — ontology consistent**

```bash
ssh root@micropx-pve.tail731306.ts.net "ls $WS/ontology && grep -ril printer $WS/ontology | sort"
```

Pass: all four baseline entries still present and linked; any new/changed entries coherent. Diff against the Task 2 output.

- [ ] **Step 6: Record the verdict**

Fill the Phase 3 section: per-criterion pass/fail with evidence, overall PASS / PARTIAL / FAIL.

---

### Task 6: Findings write-up + commit (spec: findings capture)

**Files:**
- Modify: `docs/dogfood/2026-07-04-day2-filament.md` (finalize)

**Interfaces:**
- Consumes: everything above.
- Produces: committed findings doc; ranked roadmap items.

- [ ] **Step 1: Finalize the findings doc**

Convert the live log into the run-1 format: each finding gets an F-number (continue from F7 — run 1 used F1–F6), severity (trivial / minor / HIGH / BLOCKER), one-paragraph description, and an **Action** line. End with an **Outcome** section: verdict, what held, what broke, and an explicit ranked list — "top roadmap item from this run is ___" — per the spec's rule that findings, not plans, set the roadmap.

- [ ] **Step 2: Self-check the doc**

No unexplained shorthand, no finding without severity + action, Phase 3 evidence present for all five criteria, no secrets (connection-string passwords, control token) pasted anywhere.

- [ ] **Step 3: Commit**

```bash
git add docs/dogfood/2026-07-04-day2-filament.md
git commit -m "docs(dogfood): day-2 filament run — findings and verdict"
```

---

## Self-review notes

- **Spec coverage:** Phase 0 → Task 1; Phase 1 → Task 2; Phase 2 → Tasks 3–4; Phase 3 → Task 5; findings capture → Task 6; watch-list items are embedded as Task 4 logging targets. Out-of-scope items from the spec have no tasks (correct).
- **Known unknowns are explicit:** unit names, `$REPO_DIR`, `$WS`, table names are discovered and recorded in Task 1/2, not guessed — every later command states which recorded value it consumes.
- **Deliberate deviation from code-plan TDD:** this is an operational run; "test" is the ground-truth verification task, and the baseline snapshot (Task 2) is what makes it falsifiable.
