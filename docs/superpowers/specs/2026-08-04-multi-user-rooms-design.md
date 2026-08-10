# Multi-user rooms — design

**Date:** 2026-08-04
**Status:** approved, not yet implemented
**Scope:** one spec, two implementation plans (agent-host wire + queue, then client UI)

## Why

Rhumb's "single-operator by design" goal came from a legal constraint, not an
engineering one: `subscription` mode authenticates with an OAuth token tied to a
personal Claude subscription, and Anthropic's terms restrict offering claude.ai
login or rate limits to other people. The pluggable-provider work
(`2026-07-21-pluggable-llm-provider-design.md`) added `api-key` and `gateway`
modes, where that restriction does not apply. The constraint that shaped the
product is now optional.

This spec spends that freedom on the smallest useful thing: **several people in
one conversation with one agent.**

### What is already true

Rhumb is multi-*person* today and has been since tailnet identity landed.
`RHUMB_ALLOWED_USERS` is a comma-separated allowlist and `createIdentityGuard`
admits any of them. Two people can already connect, and because `subscribers` in
`agent-host/src/server.ts` is keyed `sessionId -> Set<Response>` and `onEvent`
writes to every member, **two clients watching one session already both receive
the agent's stream.**

What is missing is not authentication and not fan-out. It is that:

1. The prompt is never broadcast — each client appends its own message locally
   via `appendUserMessage`, so a second person sees answers arrive with no
   question attached.
2. `/messages` carries no author, and the `Tailscale-User-Login` header is
   discarded after the allowlist check.
3. Every message is a fire-and-forget `manager.run`, so two people sending at
   once race two turns onto one session.

### Non-goals

- **No isolation between users.** Shared workspace, shared surfaces, shared
  ontology, shared data sources, shared session list. Everyone sees everything.
  This targets a trusted shared desk, not tenancy.
- **No human-only messages.** Every message in a room is a real agent turn.
  @-mentioning a person is text in the prompt; the agent decides whether to
  answer or defer.
- **No mention notifications.** @-ing someone who is not connected notifies
  nobody. Deferred.
- **No fleet fan-out.** mngr's ~90s turn cost makes it unusable for interactive
  chat (`2026-08-04-fleet-orchestration-design.md`). Rooms run on the `sdk`
  backend. The seam is preserved — see "Architecture".

## Approach

Three approaches were considered.

**A. Room = the existing session, thin additions.** No new objects, no new
persistence. Chosen.

**B. Room as a first-class object.** `rooms.json`, explicit membership, a room
message log separate from the agent transcript. Buys the ability to have
human-only messages and several agents per room — both explicit non-goals. Its
real cost is a second store that can disagree with the transcript.

**C. Room = session + fleet.** Each message dispatches to an mngr agent. Blocked
on the unbuilt fleet program and mngr's turn latency.

A is chosen because it is the only option where the room log needs no new
persistence, and because the flexibility B buys is speculative while the seam
that protects us already exists.

## Architecture

**A Rhumb session *is* a room.** It already has a global index every user sees,
a subscriber set that already fans out, and one agent with one context.

**Author derivation is server-side and unforgeable.** `tailscale serve` injects
`Tailscale-User-Login` and strips any caller-supplied `Tailscale-*` headers —
the property `createIdentityGuard` already depends on. `/messages` derives the
author from the same header it authenticates against. The client never sends a
name and cannot. In `RHUMB_INSECURE_DEV=1` mode there is no header and the
author is the fixed string `dev@local`.

**The seam that keeps fleet open.** The queue's executor is `manager.run`, which
sits behind the `AgentBackend` contract. Replacing serialized single-agent
execution with fleet dispatch later is a change behind that interface, not a
re-plumb of the room.

## Wire contract

### New events

Mirrored in `agent-host/src/types.ts` and `client/src/lib/types.ts`, which are
hand-mirrored by contract — the file comments say to change both together.

```ts
| { type: "message"; author: string; text: string; ts: string }
| { type: "queue"; depth: number }
| { type: "presence"; logins: string[] }
```

`message` is broadcast to every session subscriber **before** the turn starts.
The sender's client stops local-echoing and renders from the broadcast like
everyone else's, so ordering is server-authoritative and a sender's own message
cannot visually jump the queue.

`queue` carries the current depth for that session, broadcast on every enqueue
and every drain. `depth` includes the turn currently running, not just queued
ones (`depthOf = items.length + (running ? 1 : 0)`), so the client renders
`depth - 1` as "N waiting" and clears at `depth: 0`. A single number is
preferred over a per-message `queued` flag the client would have to work out
how to un-set.

`presence` carries the logins currently subscribed to the session.

### Prompt envelope

The text handed to the backend gains a one-line envelope:

```
[from: anderson@example.com]
what does the printer queue look like?
```

`RHUMB_PROMPT_APPEND` in `agent-host/src/prompt.ts` gains two lines stating that
the session is a shared room, that each turn is prefixed with its sender, and
that a turn may @-mention a human — in which case the agent answers only if
addressed or if the question is clearly for it.

The envelope buys history for free: it lands in Claude Code's own JSONL, so
`readTranscript` recovers the author by stripping the first line. No second
store, no replay buffer, and no way for "what the room said" to diverge from
"what the agent saw" — they are the same bytes.

**Attribution is asymmetric, deliberately.** Live attribution is unforgeable
because it is header-derived. Replayed attribution is best-effort: a user can
type a fake `[from: ...]` first line and spoof themselves in the log. In a
trusted shared-desk room that is a nuisance, not a threat, and the alternative
is the second store option A exists to avoid. This is documented, not fixed.

`upsertFromTurn` keeps receiving the **raw** text so session titles do not begin
with an email address.

### Roster endpoint

`GET /roster` on the **agent host**, behind the same identity and shell-header
guards as every other route there, returns `[{ login, handle }]` derived from
`RHUMB_ALLOWED_USERS`,
where `handle` is the local part of the login. If two logins collide on their
local part, both fall back to the full login as handle. Feeds @ autocomplete in
the composer. There is no source of display names, so handles are all we can
offer.

## Turn queue

Today `/messages` does fire-and-forget `void manager.run(...)` and returns 202.
Two people in a room means two concurrent `manager.run` resuming one session — a
race that forks the transcript.

**Per-session FIFO in the agent host**, in a new `agent-host/src/queue.ts`.
`POST /messages` derives the author, broadcasts `message`, enqueues, and returns
202 — always. It never returns 409 and the composer never locks. A drain loop
runs one turn at a time per session; each turn is wrapped in `try/finally` so a
throwing turn advances the queue rather than wedging it. Different rooms drain
concurrently.

### The pending-session case

A brand-new room has no session id: `inputId` is `undefined` until the `session`
event arrives mid-turn. This is why `subscribers` keeps a `""` pending bucket
and re-keys inside `onEvent` when the real id appears. The queue keys the same
way and re-keys at the same place.

What de-risks this: a session with no id yet is not in the global session list,
so nobody else can be looking at it. The `""` bucket is effectively single-user,
and genuine concurrency only begins once the room has a stable key.

### Watchdog

Watchdog turns run in their own session, so they queue independently and cannot
be stuck behind a human room. Its existing overlap guard is unchanged.

## History, attribution, and late joiners

`TranscriptMessage` gains an optional `author`. `blockToMessages` in
`agent-host/src/sessions.ts` strips the `[from: ...]` first line off user
messages and lifts it into that field. Text with no envelope yields no author,
so **every existing transcript still replays** — unattributed.

`firstUserText` and `truncateTitle` strip the envelope too, so rooms backfilled
from disk are not titled with someone's email address.

A late joiner opens a room, `GET /sessions/:id/transcript` seeds the full
attributed log, and the SSE subscription takes over. That is the existing
open-a-session path, now carrying names.

**Presence** rides on the subscription: `/sessions/:id/stream` records the login
alongside the response, and join/leave broadcasts `presence`. Reconnects produce
brief duplicates in the set, so rendering dedupes by login.

## Approvals in a room

The pending store is not session-scoped, so a gated write or infra action
already prompts everyone connected. In a shared-desk room that is the right
default — whoever is at the keyboard decides — but "who decided" stops being
obvious once there is more than one of you.

- `AuditEntry` (dashboard-host) gains `actor?: string`, set **only** when
  `auth === "approval"`. Trust-path executions have no human in the loop, so
  leaving it unset is the honest encoding. This completes the F23 distinction:
  what authorized the write, and who.
- `PendingAction` gains `resolvedBy?: string`, pairing with the existing
  `proposedBy: Proposer`.
- `InfraAuditEntry` gains `actor?: string`.

All three derive from the same header as message authorship.

**Double-approval race.** `PendingActions` (agent-host, infra approvals) already
kept a `settled` flag per entry, so the first decision wins and the second is a
no-op. `PendingQueue` (dashboard-host, gated database writes) did **not**: its
`resolve` awaited the actual write before flipping the entry out of `pending`,
so two concurrent approvals could both pass the guard and both execute —
duplicate rows, two `executed` audit entries. The final whole-branch review
(finding F3) fixed this to match: `PendingQueue.resolve` now flips the entry to
an `executing` status synchronously, before the write's `await`, exactly like
`PendingActions` setting `settled = true` before its own async work. Both
routers now return the same shape for the loser: the first decision wins, and
the second gets `409 { error: "already resolved", by, decision }` naming the
winner, instead of failing bare or (pre-fix, on the data path) silently
re-running the write. Everyone sees the outcome through the existing listener
to SSE path.

## Error handling

| Condition | Behaviour |
|---|---|
| Missing/unallowlisted identity header | 403 from the existing guard, before author derivation runs |
| `RHUMB_INSECURE_DEV=1` (no header) | Author is `dev@local` |
| A turn throws | `finally` advances the queue; the room sees the error event |
| Host restart with queued turns | **Queued-but-unstarted turns are lost.** The room shows a message with no reply |
| SSE disconnect mid-turn | Existing heartbeat and reconnect; presence dedupes by login |
| Transcript line with no envelope | Replays unattributed |
| Spoofed `[from: ...]` first line | Renders as the spoofed author on replay only; live attribution unaffected |
| Host is newer than the client (an `AgentEvent` variant the client build predates) | Client's `reduceAgent` ignores the unknown event and returns state unchanged (finding F1) rather than crashing the tab; new variants are additive by contract, so this is the expected steady state during a rolling upgrade |

The dropped-queue behaviour is accepted rather than fixed. It matches how
blocking approvals already expire on boot, and persisting the queue would mean
replaying turns whose side effects may have partly landed — worse than losing
them.

## Testing

Following the repo's TDD convention.

- **Author** — header present yields that author; `insecureDev` yields
  `dev@local`.
- **Broadcast** — two subscribers on one session both receive `message`, and
  receive it before any agent event for that turn.
- **Envelope round-trip** — a turn, then `readTranscript`, recovers the author
  and returns text with the envelope stripped.
- **Titles** — `upsertFromTurn` receives raw text, so no title contains an email
  address; `firstUserText` strips the envelope on backfill.
- **Queue** — three messages whose turns resolve out of order land in arrival
  order; a throwing turn does not wedge the drain; re-key from `""` to a real
  session id preserves pending items; `queue` depth events are correct and end
  at 0.
- **Presence** — join and leave broadcast; two connections from one login
  dedupe to a single entry.
- **Roster** — handle derivation from logins; fallback to full login on
  colliding local parts.
- **Approvals** — `actor` recorded on approval and absent on the trust path; a
  second approver is told who won.
- **Regression** — a transcript written before this change replays
  unattributed and does not error.

## Files

**agent-host** — `types.ts`, `server.ts`, `sessions.ts`, `prompt.ts`,
`identity.ts` (export a header reader), new `queue.ts`, `infra/types.ts`,
`infra/server.ts`.

**dashboard-host** — `data/types.ts`, `data/router.ts`.

**client** — `lib/types.ts`, `lib/agentEvents.ts`, `lib/chatStore.ts`,
`components/Composer.tsx`, `components/Transcript.tsx`,
`components/AgentPanel.tsx`.

## Plan split

Two implementation plans, in order:

1. **Agent-host room protocol and queue** — events, envelope, roster, queue,
   transcript attribution, presence, approval actors. Fully testable without
   touching the client.
2. **Client room UI** — render authors and presence, stop local-echoing, @
   autocomplete against the roster, queue-depth indicator. Built on a wire
   contract that already works.

## Follow-ups

- Mention notifications (Tauri desktop notification on @-mention while
  disconnected or on another room).
- Display names — needs a source beyond `RHUMB_ALLOWED_USERS`.
- Fleet-backed rooms, once P0–P2 of the fleet program land and mngr's turn cost
  is addressed.
