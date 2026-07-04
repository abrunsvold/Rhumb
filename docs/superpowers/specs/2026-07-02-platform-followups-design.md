# Platform Follow-ups Cleanup (Design)

Date: 2026-07-02
Status: Approved (scope enumerated and accepted by the operator)

## Problem

Two shipped phases (UI pass, shell+sessions) accumulated fourteen reviewed,
deliberately-deferred follow-ups — each small, none blocking, all recorded on
their PRs. This batch closes them in one stacked branch off
`feat/shell-sessions` (PR #22).

## Scope (all items; no additions)

**agent-host**
1. **Session index backfill**: on service construction, scan the workspace's
   SDK projects dir for `<uuid>.jsonl` transcripts not in the index; derive
   title/preview from the first user text message (60-char rule), timestamps
   from file mtime; skip sidechain `agent-*.jsonl` files and unparseable
   files. Pre-existing sessions then appear in the panel.

**Rust proxy**
2. **Session-id validation** (defense-in-depth): the four session commands and
   `start_session_stream` reject ids not matching `^[A-Za-z0-9-]{1,64}$`
   before building URLs.

**Client — sessions surfaces**
3. SessionsPanel refetches while open: every 15 s and whenever the running-tab
   count drops (turn completion likely changed the index).
4. SessionsPanel shows a muted inline error ("Couldn't load sessions —
   retrying…") when a fetch fails, instead of silently keeping stale/empty.
5. `useChatSessions.close()` clears the tab's `retryCount`.
6. Workspace's auto-draft mount effect is StrictMode-idempotent (ref guard).
7. SurfacesPanel rows carry `aria-selected` like the canvas tabs.

**Client — chat polish**
8. Composer's Send button reads "Sending…" while `sending` (covers the upload
   round-trip; button already disables).
9. Pre-upload size check: staging a file over 20 MB is rejected with an
   inline notice; other staged files are unaffected.
10. FileReader failures no longer reject the whole batch silently: the failed
    file is skipped and an inline notice shows.
11. Transcript styles only the leading `/command` token in monospace, not the
    whole message.
12. Canvas Detach failures surface a transient inline "Detach failed" note
    (currently a silent unhandled rejection).

**Chore**
13. Cross-reference comments on the hand-mirrored `AgentEvent` unions
    (agent-host/src/types.ts ↔ client/src/lib/types.ts); no shared package
    (polyglot-by-contract is deliberate).
14. `.gitignore` gains `*.tsbuildinfo`.

## Non-goals

Phases 2–4 of the platform sequence; toast system (inline notices only);
shared types package; any behavior change beyond the items above.

## Testing

Backfill gets fixture-based unit tests (index merge, sidechain skip, mtime
timestamps, corrupt file). Client items get RTL tests where behavior changed
(panel error state + refetch trigger, size rejection, reader-failure notice,
leading-token styling, aria-selected). Rust: compile + existing suite (id
validation mirrors the host regex; invalid id → command error). Suites must
stay green across all three packages.
