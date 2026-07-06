# Platform sweep: five small fixes

**Date:** 2026-07-04 · **Status:** approved design · **Branch:** `chore/platform-sweep` (stacked on `feat/service-redeploy`, PR #25)
**Sources:** day-2 dogfood findings F7/F16 ([docs/dogfood/2026-07-04-day2-filament.md](../../dogfood/2026-07-04-day2-filament.md)), F11-branch final-review deferrals M2/M4, chip task_89f649e0 (stale runbook curl). Chips task_08c02e1d (M4) and task_829db74e (M2) are superseded by this sweep — dismiss on merge.

## 1. F16 — ontology auto-sync on infra mutations

**Problem:** the projector regenerates system nodes (host/IP/container/status) from `services.json`/`data-sources.json` on every `ontology_sync` — but nothing calls sync after infra mutations, so the graph drifts (day-2: poller node still showed the day-1 IP; container 106 never appeared).

**Fix:** in `agent-host/src/index.ts`, construct `ontologyOps` BEFORE the infra server (pure reorder — ontology has no dependency on infra). `createInfraServer` deps gain optional `onMutate?: () => void`; each gated tool handler calls it after a SUCCESSFUL mutation only (`create_vm`, `destroy_vm`, `provision_database`, `spawn_service`, `redeploy_service`, `stop_service`, `start_service`, `destroy_service`). index.ts passes `onMutate: () => { try { ontologyOps.sync(); } catch { /* never fail the op */ } }`.

Semantics: best-effort, synchronous, swallowed. A sync failure must never affect the infra tool's result. Read-only tools (`list_*`, `*_status`) never trigger it.

**Tests:** `infra-server.test.ts` — onMutate fires exactly once per successful mutating tool call; does NOT fire when the underlying op throws (tool returns fail); absent `onMutate` is fine (optional). No projector changes.

## 2. M2 — atomic registry writes

**Problem:** `writeFileSync` on `services.json`/`data-sources.json`; a crash mid-write corrupts the file and loaders fall back to `[]` — silent registry wipe.

**Fix:** new `agent-host/src/fsAtomic.ts` exporting `atomicWriteFileSync(path: string, data: string): void` — writes `<path>.tmp-<pid>` in the same directory, then `renameSync` over the target (same-filesystem rename is atomic on POSIX); on write failure, best-effort unlink of the tmp file before rethrowing. Adopted by `services/registry.ts` (`write()`) and the `data-sources.json` writer (wherever `writeFileSync` persists the data-sources list in `src/infra/`). Sessions index and ontology vault stay as-is (rebuildable; YAGNI).

**Tests:** new `fsAtomic.test.ts` — content lands intact; no `*.tmp-*` residue after success; tmp cleaned up when the underlying write throws (simulate via unwritable dir or injected fs error if the helper takes an fs facade — keep it simple: real fs, unwritable-target case via a directory in the way of rename). Registry tests keep passing unchanged (behavioral no-op on success).

## 3. M4 — ssh error sanitization

**Problem:** `promisify(execFile)` rejections embed the full command line; the deployer's unit-file heredoc contains `Environment=` lines with credentialed connection strings, so a failed remote write can leak secrets into tool results (`fail(String(e))`), transcripts, and audit trails.

**Fix:** `agent-host/src/services/ssh.ts` wraps both `run` and `pushDir` bodies in try/catch. On failure, throw `new Error("ssh <verb> failed (exit " + code + "): " + redactedStderrTail)` where:
- verb = `command` / `copy`; exit code read from the exec error (`code` property; `"?"` if absent);
- `redactedStderrTail` = last 400 chars of the error's `stderr` (if present, else empty), passed through `redact()`: any line matching `/Environment=|postgres:\/\/|TOKEN|PASSWORD|PRIVATE KEY/i` is replaced with `"[redacted line]"`.
- The original command string NEVER appears in the thrown error.

Exported `redactSshError` helper (pure) so the redaction is unit-testable without exec.

**Tests:** extend/create ssh tests — a rejection whose `message` and `stderr` both embed `Environment=DATABASE_URL=postgres://user:pw@host/db` produces a thrown error containing neither `postgres://` nor `pw` nor `Environment=` content; exit code and benign stderr tail survive.

## 4. F7 — AskUserQuestion: disallow + steer

**Problem:** twice-observed (run-1 F1, run-2 F7): the build agent bounces goal-directed turns back as `AskUserQuestion`, which nothing in this platform can answer (headless HTTP driving; the client has no answer UI). Run 2 lost a full first pass to it.

**Fix (both halves):** in `agent-host/src/index.ts` session options:
- `disallowedTools: ["AskUserQuestion"]` (merged with any existing value; none exists today).
- `systemPrompt: { type: "preset", preset: "claude_code", append: RHUMB_PROMPT_APPEND }` where `RHUMB_PROMPT_APPEND` (exported const, ~5 lines, in a new `agent-host/src/prompt.ts`) says: you are the build agent of a self-hosted platform; destructive/infrastructure actions are operator-gated automatically — calling the tool queues the action for operator approval, so call tools directly and never pre-ask permission; the AskUserQuestion tool is unavailable and interactive Q&A is impossible mid-turn — if operator input is genuinely required, state the question in plain text in your reply and end the turn.

**Tests:** unit test that session options carry `disallowedTools` including AskUserQuestion and a systemPrompt append containing the pending-queue sentence (string containment, not full snapshot — keep it change-tolerant).

## 5. Runbook — durable operator recipe

**Problem:** the only written raw-HTTP recipes (day-2 plan doc) predate identity mode (`Authorization: Bearer` — returns 403 now); the correct `Sec-Rhumb-Control: 1` recipe exists only inside dogfood findings.

**Fix:** `agent-host/README.md` gains a "## Driving and approving over HTTP" section: send a message (`POST /agent/messages`, JSON `{prompt, sessionId?}`, header `Sec-Rhumb-Control: 1`), list pending (`GET /agent/infra/pending`), resolve (`POST /agent/infra/pending/<id>/resolve` with `{"decision":"approve"|"deny"}`), all through the tailscale-serve origin with tailnet identity; note that the header is browser-unforgeable (Sec- prefix) and the Rust client proxy sends it automatically; note `RHUMB_INSECURE_DEV=1` + Bearer is dev-only. One corrective footnote added in `docs/superpowers/plans/2026-07-04-day2-dogfood-filament.md` beside the stale recipe: "STALE — identity mode requires the Sec-Rhumb-Control shell header; see agent-host/README.md."

## Verification & scope

- Unit suites + build green across agent-host; no client/dashboard-host changes.
- Live behavioral verification of items 1 and 4 deliberately rides the NEXT dogfood run (novel-field migration) — no dedicated box session for this sweep.
- Out of scope: F8/F9/autodiscovery (client batch), F15 deploy.sh (own cycle), sessions-index/ontology-vault atomicity, journal-lines in gate evidence.
