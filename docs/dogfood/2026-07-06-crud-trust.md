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

**Turn outcome: BLOCKED — build prompt never sent.** The dev build under test could not be driven via computer-use. The verbatim prompt was never delivered; no server-side build occurred; infra pending queue remained empty throughout.

Timezone: EDT. Driver: computer-use (Task D3 recorder).

- **12:14:42** — Task start. `ps` confirms both apps up: dev build `target/debug/app` PID **17866** (started 12:06), stale installed `/Users/anderson/Applications/Rhumb.app/Contents/MacOS/app` PID **18566** (started 12:09, auto-relaunched).
- **12:14:43** — First screenshot. One Rhumb window visible, partially off-screen left; live dashboard "3D Printer Tracker" updating (K2Plus-FE91 nozzle 25.4 / bed 23.8, "live · updated 12:14:43"). Left panel: "New session", empty chat "Send a message to start a session", input "Message the agent — /", Send button, gear/Connection bottom-left. Matches D1 baseline (source `printers`, service `printer-poller`). SSE live, no freeze.
- **~12:15** — Window disambiguation. `lsappinfo`: dev PID 17866 → `CFBundleExecutablePath=…/target/debug/app`, **LSDisplayName="app"**, **CFBundleIdentifier=NULL**. Stale PID 18566 → `…/Rhumb.app/…/app`, **LSDisplayName="Rhumb"**, bundle `com.rhumb.client`. **Frontmost = stale (18566, "Rhumb")** — the visible/frontmost window was the STALE app, exactly the D3 trap.
- **~12:16** — Killed stale 18566 by path (dev PIDs 17866/17840/17671/17646 protected via case-guard). Stale **auto-relaunches within ~1s** via launchd (parent = pid 1 `/sbin/launchd`; registered as `application.com.rhumb.client…`). Re-killed relaunches 20274, 20654, 20719, 20857, 20955 across the session — whack-a-mole.
- **F20 (BLOCKER, tooling/env):** `open_application com.rhumb.client` and every focus/screenshot path resolve the shared bundle id to the **stale installed app**, never the dev binary. The dev binary is bundle-less (`CFBundleIdentifier=NULL`, display name "app"), so:
  - `request_access(["app"])` → rejected ("doesn't match any installed or running application"; suggests App Store/AppSSOAgent). Cannot grant the dev process.
  - **When stale app is dead:** the dev window is **filtered out of screenshots entirely** (native screenshotFiltering excludes the ungrantable "app" process; desktop shows through). Compositor note: *"This process owns the visible window but isn't in the installed-apps list… Pass the exact basename"* — but the basename ("app") is unresolvable.
  - **When stale app is alive:** screenshots render the bundle window again, and `osascript … set frontmost of (process whose unix id is 17866)` DOES report dev (17866) frontmost. Clicks at the window region **land** (no Finder/desktop error). BUT `type` and `key` both fail with *"Claude's own window still has keyboard focus … after the pre-action defocus"* — **keyboard focus never transfers to the bundle-less dev window**, so no text can be entered.
- **12:20:33–12:22:22** — Repeated attempts with stale-alive + osascript-activate-dev + click-input: click succeeds, `type "Track my filament spools…"` fails (focus guard), `key "x"` fails (same guard), clipboard-paste path blocked by the same focus requirement. **Verbatim build prompt could NOT be sent.**
- **12:21:52** — Read-only check: dev build 17866 still running and SSE-live (dashboard updating 12:20:15). Infra pending queue **empty** (`{"pending":[]}`) — consistent with no prompt sent.
- **12:22:22** — Turn declared BLOCKED. No `provision_database`, no `CREATE TABLE`, no `/data` writes, no gated actions — none reachable because the build never started.

**Watch-list results (all N/A — build never initiated):**
- (a) provision_database + read-write auto-register: **not observed** (no build).
- (b) structured `/data/*` writes vs raw SQL: **not observed**.
- (c) F17 CREATE TABLE gating: **not observed**.
- (d) F8 client send-loop wedge: **N/A** — could not even send once; the blocker is upstream of the send loop (focus-transfer to dev window impossible), not the F8 multi-approval wedge.
- (e) F9 transcript follow/jump pill: **not observed**.
- (f) SSE staleness/freeze: **none observed** — dashboard stayed live throughout (12:14:43 → 12:20:15 updates).

**Root cause of block:** dev build is a bundle-less Tauri debug binary (`target/debug/app`, no `CFBundleIdentifier`, display name "app"). computer-use's access grant + native screenshot filtering + key-window focus all key off installed-app identity, which the dev binary lacks; the shared-bundle stale app (Rhumb.app, keepalive-relaunched by launchd) shadows it. Net: dev window is invisible when stale is dead, and unfocusable-for-typing when stale is alive. Not a Rhumb product bug — an interaction between the dogfood dev-build setup and the computer-use harness. **Recommendation for a re-run:** ship the dev build as a proper `.app` with a distinct bundle id (e.g. `com.rhumb.client.dev`) OR stop the launchd keepalive for `Rhumb.app` during the turn, so the dev window is uniquely grantable and focusable. Driving the stale installed app instead was rejected (it runs pre-F8/F9/F14 client code and would invalidate client-side watch-list d/e).

**IDs for D4:** new data-source id = **none created**; surface id = **none created** (build never ran).

## Phase 3 — the write session (trust ladder + adversarial probes)
## Findings
## Phase 4 — ground-truth verification
## Outcome
