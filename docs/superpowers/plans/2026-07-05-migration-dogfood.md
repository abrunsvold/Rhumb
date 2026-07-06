# Migration Dogfood Run Plan — novel-field ALTER + live fix-stack validation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the approved migration dogfood (spec: `docs/superpowers/specs/2026-07-05-migration-dogfood-design.md`) — deploy the fix stack, drive one gated turn that adds a genuinely-new per-job max-temperature field (forcing a live ALTER + poller redeploy via `redeploy_service`), and verify the clean cutover that day-2 failed.

**Architecture:** Operational run, not a code plan — the platform's build agent writes whatever code the change needs. Our tasks: deploy the branch-tip fix stack to the box, snapshot the baseline, connect the fixed client, drive one turn from it, verify ground truth (headline: clean blue-green cutover), and write findings. Box-specific values are recorded in Task M1 and reused as shell variables.

**Tech Stack:** SSH to `micropx-pve.tail731306.ts.net`; `node` + `pg` from the deployed agent-host `node_modules` (no `psql`); `curl`; the Tauri client via `npm run tauri:dev` in `client/` driven by computer-use; `systemctl`/`journalctl`/`pct`.

## Global Constraints

- **Observe, don't rescue.** During the turn (Task M4) issue NO manual commands against the box/DB/containers. If the agent stalls or fails, that is the finding.
- **The headline pass criterion is the clean cutover** (Task M5 C1): exactly one poller container, registry moved to a new containerId+deployId, old container gone, three-way provenance match. This is the inverse of day-2's orphaned-106 failure and the whole reason the run exists.
- **Findings drive the roadmap;** the write-up (Task M6) ranks them. If C1 passes, PRs #25/#26/#28 are validated for merge; if it regresses, that is the top finding and merge waits.
- **Box facts** (recorded, from prior runs): `$BOX`=micropx-pve.tail731306.ts.net (SSH root); `$REPO_DIR`=/root/rhumb; `$WS`=/root/rhumbr-workspace; units `rhumbr-agent.service`/`rhumbr-dashboard.service`; `$ENV_FILE`=/root/rhumb.env (control token `RHUMB_CONTROL_TOKEN` lives here — never paste its value); `$DEPLOY_KEY`=/root/rhumb-deploy. Serve fronts `https://$BOX/` (dashboard) and `https://$BOX/agent`. Poller currently container **106**, deployId `20260704212359-d25440`.
- **Branch under test:** `fix/client-chat-discovery` tip `2f0f179` (carries all of PR #25/#26/#28). No repo code changes in this run — only the dogfood run-log doc + commits.
- **No secrets** in the run log, runsheet, or reports (DB passwords, control token, OAuth token).
- **Run log:** `docs/dogfood/2026-07-05-migration.md`, timestamps local (`date '+%H:%M:%S'`), pasted-evidence discipline (the project was burned once by a false success — every criterion gets command + output).

---

### Task M1: Deploy the fix stack (spec Phase 0)

**Files:** none in repo (box work); create `.superpowers/sdd/mig-runsheet.md` for recorded values.

**Interfaces:**
- Produces: `$AGENT_BUILD_REV` (branch tip deployed), `$OLD_BACKUP` (backup tarball path), confirmation the new capabilities are live, PHASE0 step count + wall time.

- [ ] **Step 1: Timer + build locally.** `date '+%H:%M:%S'`. From the worktree, build both hosts: `cd agent-host && npm ci && npm run build`; `cd ../dashboard-host && npm ci && npm run build`. (The branch tip is `2f0f179`; confirm `git rev-parse --short HEAD`.)

- [ ] **Step 2: Back up the box deploy.** `ssh root@$BOX 'tar czf /root/rhumb-backup-mig-$(date +%Y%m%d-%H%M%S).tgz -C /root rhumb'` → record the path as `$OLD_BACKUP`.

- [ ] **Step 3: Ship source, build on box.** Tar each host's source (src, package.json, package-lock.json, tsconfig.json, vitest.config.ts, test/) — NOT node_modules (box is linux-x64; build there). scp to `/tmp`, extract over `$REPO_DIR/agent-host` and `$REPO_DIR/dashboard-host`, then on the box `cd $REPO_DIR/agent-host && npm ci && npm run build` and same for dashboard-host. Restart: `systemctl restart rhumbr-agent.service rhumbr-dashboard.service`. If a host fails to boot on a missing env var, add ONLY that var to `$ENV_FILE` and record it as a finding; if unrecoverable, restore `$OLD_BACKUP`, restart, verify health, report BLOCKED (box must not be left down).

- [ ] **Step 4: Health check.** `ssh root@$BOX 'curl -s http://127.0.0.1:8787/healthz && curl -s http://127.0.0.1:8788/healthz'` → both `{"ok":true}`. From the Mac: `curl -s https://$BOX/agent/healthz` → `{"ok":true}`.

- [ ] **Step 5: Confirm the new capabilities are live** (the point of deploying the stack):
  - **redeploy_service present:** drive a throwaway agent turn asking it to `list` its infra tools, OR simpler — grep the deployed source: `ssh root@$BOX "grep -c redeploy_service $REPO_DIR/agent-host/dist/infra/server.js"` → ≥1.
  - **Heartbeat live:** `ssh root@$BOX "grep -c keepalive $REPO_DIR/agent-host/dist/sse.js"` → ≥1 (the `:keepalive` frame). (A live SSE curl would need a turn; the built-artifact check suffices for Phase 0.)
  - **F16 auto-sync wired:** `ssh root@$BOX "grep -c onMutate $REPO_DIR/agent-host/dist/infra/server.js"` → ≥1.
  - Record all three.

- [ ] **Step 6: Rebuild the client.** `cd client && npm ci && npm run build` (Tauri app is launched in Task M3). Confirm `tsc`/vite clean.

- [ ] **Step 7: Stop timer, record friction.** Steps count + wall time + any non-mechanical surprises → `mig-runsheet.md`. Feeds the standing F15 on-ramp signal.

---

### Task M2: Baseline snapshot (spec Phase 1)

**Files:** Create `docs/dogfood/2026-07-05-migration.md` (run log skeleton); append values to `.superpowers/sdd/mig-runsheet.md`.

**Interfaces:**
- Consumes: box facts from M1.
- Produces: `$DB` (printers datasource, redacted), `$POLLER_CTR`/`$POLLER_IP`/`$POLLER_DEPLOYID`, baseline schema+counts+ontology pasted in the run log.

- [ ] **Step 1: Create the run log skeleton** at `docs/dogfood/2026-07-05-migration.md`:

```markdown
# Dogfood run — novel-field migration + live fix-stack validation

**Date:** 2026-07-05 · **Spec:** ../superpowers/specs/2026-07-05-migration-dogfood-design.md
**Branch under test:** fix/client-chat-discovery @ 2f0f179 (PR #25+#26+#28)
**Headline claim:** redeploy_service now cleanly cuts over a real change (the day-2 orphaned-container BLOCKER, fixed).

## Phase 0 — fix-stack deploy (on-ramp friction)
## Phase 1 — baseline
## Phase 2 — the turn (live log)
## Findings
## Phase 3 — ground-truth verification
## Outcome
```

- [ ] **Step 2: Datasource + schema + counts.** `ssh root@$BOX "cat $WS/data-sources.json"` → record printers entry host/db/user only (redact password) as `$DB`. Then snapshot schema + counts via the deployed agent-host `pg` (no psql):

```bash
ssh root@$BOX "cd $REPO_DIR/agent-host && DB='$DB' node -e '
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

Paste the full output into Phase 1 — the diff target.

- [ ] **Step 3: Service + ontology + surface baseline.** `ssh root@$BOX "cat $WS/services.json"` → record `$POLLER_CTR` (expect 106), `$POLLER_IP`, `$POLLER_DEPLOYID` (expect `20260704212359-d25440`), status. Then `ssh root@$BOX "ls $WS/ontology && grep -ril printer $WS/ontology | sort"` and capture the container/service node contents (id/IP) — the F16 diff target. `ssh root@$BOX "curl -s -o /dev/null -w 'surface:%{http_code}\n' http://127.0.0.1:8788/surfaces/printer-tracker/"`.

- [ ] **Step 4: Commit the skeleton.**

```bash
git add docs/dogfood/2026-07-05-migration.md
git commit -m "docs(dogfood): migration run log — phase 0/1 baseline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task M3: Client launch + connect (spec Phase 2 prep)

**Files:** none modified.

**Interfaces:**
- Consumes: control token (read from `$ENV_FILE` on demand; never persist).
- Produces: a connected client window on the updated stack, ready for the turn; discovery-path observation (F14).

- [ ] **Step 1: Launch.** `cd client && npm run tauri:dev` (background). Wait for the window (computer-use; cold Rust build up to ~4 min).

- [ ] **Step 2: Connect + observe discovery (F14).** On the connection screen, first try Rescan/autodiscovery — record what it now shows (the new diagnostic: peers scanned + per-peer outcomes, or a host match). Then connect (autodiscovery pick if it worked, else manual `https://$BOX`). Record which path connected. Sessions panel should populate.

- [ ] **Step 3: Verify pending-actions reachable.** Open the pending UI (empty). Raw cross-check: `curl -s -H "Sec-Rhumb-Control: 1" https://$BOX/agent/infra/pending` → `{"pending":[]}`.

---

### Task M4: The turn (spec Phase 2)

**Files:** Modify `docs/dogfood/2026-07-05-migration.md` (Phase 2 live log).

**Interfaces:**
- Consumes: connected client (M3), baseline (M2).
- Produces: completed turn + timestamped log with F-numbered observations.

- [ ] **Step 1: New chat session; send verbatim.**

```
Track the hottest nozzle and bed temperature reached during each print job, and show it on the dashboard.
```

Record send time.

- [ ] **Step 2: Observe; approve via the client pending UI.** Rules: read each pending action fully, approve everything reasonable (the test is the platform), deny only a data-destroying action (a bare `DROP`/`TRUNCATE` on a populated table). Log every event timestamped. **Watch-list — these are the fixes under validation, log each explicitly:** (a) does the agent call `redeploy_service` (not `spawn_service`, which now hard-errors on an existing id)? (b) does the redeploy cut over cleanly or warn? (c) does the client send loop stay responsive across the multi-approval sequence (F8 — no wedge)? (d) does the transcript follow the live edge / need the jump pill (F9)? (e) does the agent avoid a dead `AskUserQuestion` (F7)? No manual box commands until the turn is over.

  Raw fallback ONLY if the client pending UI fails (record as a client finding): `curl -s -H "Sec-Rhumb-Control: 1" https://$BOX/agent/infra/pending` and `curl -s -X POST -H "Sec-Rhumb-Control: 1" -H 'content-type: application/json' -d '{"decision":"approve"}' https://$BOX/agent/infra/pending/<ID>/resolve`.

- [ ] **Step 3: Declare the turn over.** Ends on agent completion, ~15 min no-progress, or plain failure. Record end time + the agent's verbatim final claim (checked in M5). Then the ONE allowed post-turn read-only curl: pending queue empty. Commit the Phase-2 log:

```bash
git add docs/dogfood/2026-07-05-migration.md
git commit -m "docs(dogfood): migration run — phase 2 live turn log

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task M5: Ground-truth verification (spec Phase 3)

**Files:** Modify `docs/dogfood/2026-07-05-migration.md` (Phase 3). Read-only on box (SELECT / cat / ls / systemctl status / journalctl / pct list / pct config).

**Interfaces:**
- Consumes: baseline (M2), turn log + agent claim (M4), `$DB`/`$DEPLOY_KEY`.
- Produces: per-criterion verdict.

- [ ] **Step 1: C1 — clean cutover (HEADLINE, F11).** `ssh root@$BOX "pct list"` → **exactly one** `rhumb-printer-poller` container; record its id. `ssh root@$BOX "cat $WS/services.json"` → NEW containerId (≠106), NEW deployId (≠ `20260704212359-d25440`), `updatedAt` present, status healthy. Confirm the OLD 106 is **absent** from `pct list`. Three-way provenance: `pct exec <new> -- cat /opt/rhumb/printer-poller/.rhumb-deploy.json` deployId == unit `RHUMB_DEPLOY_ID` (`pct exec <new> -- systemctl cat rhumb-printer-poller | grep DEPLOY_ID`) == registry deployId. Restart count low: `pct exec <new> -- systemctl show -p NRestarts rhumb-printer-poller` (single digits, not day-2's ~500). Any orphan/unmoved-registry = FAIL and top finding.

- [ ] **Step 2: C2 — migration landed.** Re-run the M2 Step-2 schema query; confirm the NEW max-nozzle/max-bed columns on the jobs table, numeric type, schema otherwise column-identical to baseline. `pct exec <new> -- grep -iE "max|GREATEST|Math.max" /opt/rhumb/printer-poller/index.js | head` → the running-max logic is present in live code.

- [ ] **Step 3: C3 — data preserved.** From the same schema/count query: all 6 baseline tables present; `telemetry_samples` ≥ baseline and climbing; no table truncated.

- [ ] **Step 4: C4 — F16 auto-sync, no manual call.** `ssh root@$BOX "grep -ril printer $WS/ontology"` then read the container/service node — it must reference the NEW container id/IP, updated during the turn with no manual `ontology_sync`. Diff against the Phase-1 ontology capture. (If it still shows 106 / old IP → F16 didn't fire on this mutation → finding.)

- [ ] **Step 5: C5 — F7/F8/F9 from the log.** From the Phase-2 log: no wasted `AskUserQuestion` (F7); the client send never wedged across approvals (F8); transcript followed / jump pill worked (F9). Record pass/fail with the log timestamps as evidence.

- [ ] **Step 6: C6 — surface.** `ssh root@$BOX "curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/surfaces/printer-tracker/ && curl -s http://127.0.0.1:8788/surfaces/printer-tracker/ | grep -ci 'nozzle\|bed\|temp'"` → 200 and ≥1. One sentence on what it renders.

- [ ] **Step 7: Record verdict.** Fill Phase 3 with per-criterion PASS/FAIL + pasted evidence, overall PASS/PARTIAL/FAIL. State plainly whether C1 passed (→ stack validated for merge) or regressed (→ merge waits). Note the plumbing-at-idle caveat (temps read 0/NULL, printers idle). Commit:

```bash
git add docs/dogfood/2026-07-05-migration.md
git commit -m "docs(dogfood): migration run — phase 3 ground truth

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task M6: Findings write-up + commit

**Files:** Modify `docs/dogfood/2026-07-05-migration.md` (finalize).

- [ ] **Step 1: Finalize.** Run-1 format: F-numbered findings (continue from F16 → start F17) with severity + Action; positive-findings block (what the fixes proved); Outcome with the explicit merge verdict for #25/#26/#28 and a ranked roadmap. If C1 passed, say so as the lead: "day-2 BLOCKER fixed, proven live." If anything regressed, that leads instead.

- [ ] **Step 2: Self-check.** No secrets; every finding has severity+action; all six criteria have pasted evidence; the merge recommendation is explicit.

- [ ] **Step 3: Commit.**

```bash
git add docs/dogfood/2026-07-05-migration.md
git commit -m "docs(dogfood): migration run — findings and merge verdict

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Operator cleanup note.** Record (do NOT perform): the pre-run backup `$OLD_BACKUP` and any prior orphaned containers are deletable after acceptance; if the turn left any orphan (C1 fail), name it with a `pct stop/destroy` recommendation.

---

## Self-review notes

- **Spec coverage:** Phase 0 → M1 (deploy + capability confirmation); Phase 1 → M2; Phase 2 → M3–M4; Phase 3 → M5 (all six criteria: C1 cutover, C2 migration, C3 data, C4 F16, C5 F7/F8/F9, C6 surface); findings → M6. Out-of-scope items (PR merge, CRUD run, data-bearing ALTER) have no tasks.
- **Discovered-not-guessed:** box facts recorded in M1/M2 and reused; the new poller container id is discovered in M5 (never hardcoded — 106 is the OLD one, expected to be gone).
- **Deliberate deviation from code-plan TDD:** operational run; "test" is Phase 3 ground-truth verification, and the M2 baseline is what makes it falsifiable. The headline (C1) is the inverse of the day-2 failure, checked with pasted `pct list` evidence per the burned-once discipline.
