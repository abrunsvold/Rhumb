# CRUD Trust-Gate Dogfood Run Plan — filament spool inventory

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the approved CRUD trust-gate dogfood (spec: `docs/superpowers/specs/2026-07-06-crud-trust-dogfood-design.md`) — build a filament-spool tool with an agent-provisioned Postgres + write-back surface, then exercise the write-back loop, trust ladder, and adversarial probes end-to-end live for the first time.

**Architecture:** Operational run, not a code plan — the platform's build agent writes whatever the tool needs. Our tasks: snapshot the baseline, connect the client, drive the build turn, run the write session (trust ladder + probes), verify ground truth, write findings. Box code is already merged-main (no deploy). Box-specific values are discovered in D1 and reused as shell variables.

**Tech Stack:** SSH to `micropx-pve.tail731306.ts.net`; `node`+`pg` from the deployed dashboard-host/agent-host `node_modules` (no `psql`); `curl`; the Tauri client via `npm run tauri:dev` in `client/` driven by computer-use; the dashboard-host `/data/*` write API.

## Global Constraints

- **Observe, don't rescue** applies to the BUILD turn (D3): no manual box/DB/container commands during it. The WRITE session (D4) is the opposite — the operator is actively using and probing the surface, so curl/devtools are expected there.
- **Two facts the run characterizes** (from the code map): trust is per-(source, surface) only — one "trust this surface" approval auto-executes every future write (any table, any op incl. DELETE); DDL (`CREATE/ALTER/DROP TABLE`) is in no gate's vocabulary (F17).
- **Route facts** (dashboard-host `/data/*`, verified): write = `POST /data/:source/write` with header `x-rhumb-surface-token: <surface token>`, body `{op:{kind:"insert"|"update"|"delete"|"select", table, ...}}` → 202 `{pendingId}` if untrusted, or `{status:"executed"}` if trusted. `source.mode` must be `read-write` (else 403). `/data/:source/pending*` is behind the `Sec-Rhumb-Control: 1` shell guard (browser JS can't set it). Trust approval = `POST /data/:source/pending/:id/resolve` body `{"decision":"approve","trustSurface":true}`. Identifiers pass `ident()` whitelist `^[A-Za-z_][A-Za-z0-9_]*$` (throws before SQL is built).
- **Box facts:** `$BOX`=micropx-pve.tail731306.ts.net (SSH root); `$WS`=/root/rhumbr-workspace; data files under `$WS`: `data-sources.json`, `data-trust.json`, `data-audit.jsonl`; `$REPO_DIR`=/root/rhumb; serve fronts dashboard at `https://$BOX/`, agent at `https://$BOX/agent`. Control token in `/root/rhumb.env` (`RHUMB_CONTROL_TOKEN`) — never persist its value.
- **Branch:** `dogfood/crud-trust` off main (cd1266e). No product-code changes — only the run-log doc + commits.
- **No secrets** in the run log, runsheet, or reports (DB passwords, control token, OAuth, surface tokens).
- **Run log:** `docs/dogfood/2026-07-06-crud-trust.md`, timestamps local (`date '+%H:%M:%S'`), pasted-evidence discipline — every criterion gets command + output.

---

### Task D1: Baseline snapshot (spec Phase 1)

**Files:** Create `docs/dogfood/2026-07-06-crud-trust.md` (run log skeleton); append recorded values to `.superpowers/sdd/crud-runsheet.md`.

**Interfaces:**
- Produces: baseline of `data-sources.json` (expect only `printers`), `data-trust.json` + `data-audit.jsonl` (expect empty/absent), `services.json`, ontology; recorded so "new read-write source" and "trust persisted" are checkable.

- [ ] **Step 1: Create the run log skeleton** at `docs/dogfood/2026-07-06-crud-trust.md`:

```markdown
# Dogfood run — write-back / CRUD trust-gate (filament spool inventory)

**Date:** 2026-07-06 · **Spec:** ../superpowers/specs/2026-07-06-crud-trust-dogfood-design.md
**Box code:** merged main (cd1266e) — no redeploy this run.
**Claim under test:** the write-back loop (provision → write → gate → trust → audit) works end-to-end live, and the trust model's real (coarse) behavior is documented.

## Phase 0/1 — client ready + baseline
## Phase 2 — the build turn (live log)
## Phase 3 — the write session (trust ladder + adversarial probes)
## Findings
## Phase 4 — ground-truth verification
## Outcome
```

- [ ] **Step 2: Snapshot the data-plane baseline (read-only).**

```bash
ssh root@micropx-pve.tail731306.ts.net "echo '--- data-sources ---'; cat $WS/data-sources.json 2>/dev/null || echo '(absent)'; echo '--- data-trust ---'; cat $WS/data-trust.json 2>/dev/null || echo '(absent)'; echo '--- data-audit (line count + tail) ---'; wc -l $WS/data-audit.jsonl 2>/dev/null || echo '(absent)'; tail -3 $WS/data-audit.jsonl 2>/dev/null"
```

Record into Phase 0/1: the data-source ids present (expect just `printers`, mode likely `read-write` from prior runs — note its mode), whether `data-trust.json` exists and its contents (expect `[]`/absent — trust starts clean), and the `data-audit.jsonl` line count (the "before" count so new writes are countable). Redact any connection-string passwords.

- [ ] **Step 3: Snapshot services + ontology (context).** `ssh root@$BOX "cat $WS/services.json | grep -o '\"id\":[^,]*'; ls $WS/ontology"`. Record the existing service/ontology entries so a new spool tool's additions are visible.

- [ ] **Step 4: Commit the skeleton.**

```bash
git add docs/dogfood/2026-07-06-crud-trust.md
git commit -m "docs(dogfood): CRUD trust run log — phase 0/1 baseline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task D2: Client launch + connect (spec Phase 0)

**Files:** none modified.

**Interfaces:**
- Consumes: control token (read from `/root/rhumb.env` on demand; never persist).
- Produces: a connected client window on the merged-main box, ready for the build turn; client PIDs recorded.

- [ ] **Step 1: Launch.** `cd client && npm ci && npm run tauri:dev` (background; the client was already rebuilt+tested this session, so this is a warm build). Wait for the window (computer-use).

- [ ] **Step 2: Connect.** Use manual Server URL `https://micropx-pve.tail731306.ts.net` (F14 GUI autodiscovery is a known-open chip — go straight to manual). Confirm the shell loads and the sessions panel populates. Record the client PIDs (`ps` by process name: `target/debug/app`, vite, tauri, npm) so D3 can confirm liveness.

- [ ] **Step 3: Verify both pending surfaces reachable.** The build turn will use the INFRA pending queue (provision_database) and the write session the DATA pending queue. Raw cross-check both are empty:

```bash
curl -s -H "Sec-Rhumb-Control: 1" https://micropx-pve.tail731306.ts.net/agent/infra/pending
curl -s -H "Sec-Rhumb-Control: 1" https://micropx-pve.tail731306.ts.net/data/printers/pending
```

Expect `{"pending":[]}`. (Second one proves the data-pending control plane is up and shell-guarded.)

---

### Task D3: The build turn (spec Phase 2, observe-don't-rescue)

**Files:** Modify `docs/dogfood/2026-07-06-crud-trust.md` (Phase 2 live log).

**Interfaces:**
- Consumes: connected client (D2).
- Produces: a built + running spool tool (provisioned DB + write-back surface); timestamped log with F-numbered observations (continue from F19 → start F20).

- [ ] **Step 1: New chat session; send verbatim.**

```
Track my filament spools — material, color, weight remaining; let me add spools and update remaining weight from the dashboard.
```

Record send time.

- [ ] **Step 2: Observe; approve gated INFRA actions via the client dialog.** The `provision_database` call hits the *infra* pending queue → approve via the client ConfirmationDialog (infra branch). Log every event timestamped. **Watch-list (log each explicitly):** (a) does the agent call `provision_database`, and does the new source auto-register as `read-write` in data-sources.json? (b) does the surface it builds issue structured `/data/*` write ops (insert/update) rather than raw SQL? (c) **F17:** how does the schema `CREATE TABLE` happen — ungated Bash/apply again, or a gated path? (d) client send loop across the multi-approval build (F8, n>1) — any wedge? (e) transcript follow (F9). No manual box commands until the turn is over.

Raw fallback ONLY if the client dialog fails (record as a client finding): `curl -s -H "Sec-Rhumb-Control: 1" https://$BOX/agent/infra/pending` then `curl -s -X POST -H "Sec-Rhumb-Control: 1" -H 'content-type: application/json' -d '{"decision":"approve"}' https://$BOX/agent/infra/pending/<ID>/resolve`.

- [ ] **Step 3: Declare the turn over.** Ends on agent completion, ~15 min no-progress, or plain failure. Record end time + the agent's verbatim final claim (checked in D5). Note the surface id it created and the new data-source id (needed for D4). Commit the Phase-2 log:

```bash
git add docs/dogfood/2026-07-06-crud-trust.md
git commit -m "docs(dogfood): CRUD trust run — phase 2 build turn log

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task D4: The write session — trust ladder + adversarial probes (spec Phase 3)

**Files:** Modify `docs/dogfood/2026-07-06-crud-trust.md` (Phase 3 log).

**Interfaces:**
- Consumes: the built surface + new data-source id + surface id (D3); the client ConfirmationDialog (data branch, never rendered live before).
- Produces: the full trust-ladder + probe log with per-write evidence.

This phase is interactive operator use — curl and reading the surface's injected token are expected (NOT a rescue). Get the surface's `x-rhumb-surface-token` for the write-side probes by reading it from the surface's served page (the injected shim) or the client canvas iframe DOM; note where you got it, never persist its value.

- [ ] **Step 1: Trust ladder via the surface UI (in the client canvas).** Open the spool surface in the client. Log each with timestamp + what the dialog showed + whether the row reached the DB:
  1. **Add spool #1** via the surface's add form → the write enqueues (data pending) → the client ConfirmationDialog renders the DATA branch ("Write to \"<source>\"" + surface id) → **approve WITHOUT trust** → executes.
  2. **Add spool #2** → enqueues → **approve WITH "trust this surface"** (the dialog's trust checkbox → resolve body `trustSurface:true`) → executes.
  3. **Update spool #1's remaining weight** via the surface → **executes silently** (trusted; no dialog appears).

  Record the client dialog's DATA-branch rendering verbatim (screenshot/zoom) — this is its first live exercise.

- [ ] **Step 2: Adversarial probe — trust coarseness (DELETE).** With the surface now trusted, issue a DELETE op (via the surface if it has a delete control, else curl with the surface token):

```bash
curl -s -X POST -H "x-rhumb-surface-token: <SURFACE_TOKEN>" -H 'content-type: application/json' \
  -d '{"op":{"kind":"delete","table":"<spool_table>","where":{"id":<some_id>}}}' \
  https://micropx-pve.tail731306.ts.net/data/<SOURCE_ID>/write
```

Record whether it returned `{"status":"executed"}` (trust covers DELETE — the coarseness finding) or `{"status":"pending"}` (it re-gated). Either way it's a finding about the trust model's real scope.

- [ ] **Step 3: Adversarial probe — self-approve guard.** Attempt to read/resolve the data pending queue WITHOUT the shell header (simulating the surface's own page JS):

```bash
curl -s -o /dev/null -w 'no-header:%{http_code}\n' https://micropx-pve.tail731306.ts.net/data/<SOURCE_ID>/pending
curl -s -o /dev/null -w 'with-header:%{http_code}\n' -H "Sec-Rhumb-Control: 1" https://micropx-pve.tail731306.ts.net/data/<SOURCE_ID>/pending
```

Expect `no-header:403` and `with-header:200` — the surface cannot bless its own write.

- [ ] **Step 4: Adversarial probe — identifier whitelist.** Submit a write with a malformed identifier and (if it enqueues) approve it, expecting an execute-time rejection, no malformed SQL reaching the DB:

```bash
curl -s -X POST -H "x-rhumb-surface-token: <SURFACE_TOKEN>" -H 'content-type: application/json' \
  -d '{"op":{"kind":"insert","table":"bad name; drop table x","values":{"material":"x"}}}' \
  https://micropx-pve.tail731306.ts.net/data/<SOURCE_ID>/write
```

Record the outcome — it should fail (the `ident()` whitelist throws before SQL is built; audit records `error`, no injection). If the surface is trusted this errors inline (500 `write failed`); log which.

- [ ] **Step 5: Commit the Phase-3 log.**

```bash
git add docs/dogfood/2026-07-06-crud-trust.md
git commit -m "docs(dogfood): CRUD trust run — phase 3 write session + probes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task D5: Ground-truth verification (spec Phase 4)

**Files:** Modify `docs/dogfood/2026-07-06-crud-trust.md` (Phase 4). Read-only on box (SELECT / cat / ls).

**Interfaces:**
- Consumes: baseline (D1), build + session logs (D3/D4), the new source id + spool table.
- Produces: per-criterion verdict.

- [ ] **Step 1: C1 provisioning.** `cat $WS/data-sources.json` → a NEW entry (≠ printers), `mode:"read-write"`. Via the dashboard-host `pg`: the DB + spool table exist with the expected columns (material/color/weight columns). Paste the schema query output.

- [ ] **Step 2: C2 gated write executed.** The first (untrusted, approved) add landed a real row (SELECT the table, show the row). `data-audit.jsonl` has a `decision:"executed"` entry for it (grep + paste). Compare count to the D1 baseline line count.

- [ ] **Step 3: C3 trust persisted + honored.** `cat $WS/data-trust.json` → contains the `(source, surface)` pair from the session. The trusted update executed with NO pending entry — audit shows `executed` for it and the queue never held it (cross-check the Phase-3 log: no dialog appeared for the update).

- [ ] **Step 4: C4 coarseness finding.** From D4 Step 2: did the post-trust DELETE skip the gate? Record the verdict with the pasted curl output and the resulting DB state (row gone or not).

- [ ] **Step 5: C5 guards held.** From D4 Step 3–4: self-approve got 403 (paste); malformed identifier was rejected with no malformed SQL in the DB (confirm the bad table name does NOT exist: `SELECT to_regclass('...')` → null; audit shows `error`).

- [ ] **Step 6: C6 audit integrity.** Every write attempted in the session (adds, update, delete, malformed) has a matching `data-audit.jsonl` line (executed/denied/error). Count session writes vs new audit lines; paste the new tail.

- [ ] **Step 7: C7 (F17 re-observed).** From the D3 log: how did `CREATE TABLE` happen — ungated Bash/apply, or a gated path? Record as a carried finding.

- [ ] **Step 8: Record verdict.** Fill Phase 4 with per-criterion PASS/FAIL + pasted evidence; overall PASS/PARTIAL/FAIL. State plainly: did the write-back loop work end-to-end live, and is the trust coarseness now documented with evidence? Commit:

```bash
git add docs/dogfood/2026-07-06-crud-trust.md
git commit -m "docs(dogfood): CRUD trust run — phase 4 ground truth

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task D6: Findings write-up + roadmap

**Files:** Modify `docs/dogfood/2026-07-06-crud-trust.md` (finalize).

- [ ] **Step 1: Finalize.** Run-1 format: F-numbered findings (continue from F19 → start F20) with severity + Action; positive-findings block (what the write-back stack proved live — first end-to-end exercise). Likely findings to shape: trust coarseness (does one approval blessing all future writes incl. DELETE feel right? — Action: consider per-op or per-table trust scoping), F17/DDL ungated (Action: gate DDL or document as intentional), client ConfirmationDialog data-branch behavior, any audit gaps. Outcome states the overall verdict + a ranked roadmap.

- [ ] **Step 2: Self-check.** No secrets (surface tokens, DB passwords, control token); every finding has severity + action; all criteria have pasted evidence; the trust-coarseness finding is explicit with its evidence.

- [ ] **Step 3: Commit.**

```bash
git add docs/dogfood/2026-07-06-crud-trust.md
git commit -m "docs(dogfood): CRUD trust run — findings and roadmap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Operator cleanup note.** Record (do NOT perform): the spool tool + its provisioned DB can be kept (it's a useful tool) or torn down via destroy_service/drop; note any test rows the probes left behind.

---

## Self-review notes

- **Spec coverage:** Phase 0/1 → D1+D2; Phase 2 → D3; Phase 3 (trust ladder + 3 probes) → D4; Phase 4 (7 criteria incl. coarseness, guards, audit integrity, F17) → D5; findings → D6. Out-of-scope items (fixing findings, F14 chip, multi-surface trust) have no tasks.
- **Discovered-not-guessed:** the new source id, surface id, and spool table name are discovered in D3 and reused in D4/D5 (never hardcoded — printers is the OLD source). Surface token is read live, never persisted.
- **Deliberate deviation from code-plan TDD:** operational run; "test" is Phase 4 ground-truth, and the D1 baseline (clean trust/audit) makes it falsifiable. Observe-don't-rescue binds only the build turn (D3); the write session (D4) is active operator probing by design.
