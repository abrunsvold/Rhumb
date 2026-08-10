# Multi-user rooms — client design

**Date:** 2026-08-05
**Status:** approved, not yet implemented
**Depends on:** `2026-08-04-multi-user-rooms-design.md` (server slice, PR #47)
**Scope:** plan 2 of that spec's two, plus two small server additions and one
folded-in correctness fix

## Why

The server slice made a Rhumb session a room on the wire: turns carry an
unforgeable author, a per-session FIFO queue serializes them, and every watcher
receives `message`, `queue`, and `presence` events. None of it is visible. The
client mirrors the event types so the build stays honest, and then ignores all
three.

This spec makes the room visible, and folds in the one correctness limitation
the server slice knowingly left open — because closing it needs a client change,
and it lands in exactly the send path this work already rewrites.

## Non-goals

Unchanged from the server spec: no isolation between users, no human-only
messages, no mention notifications, no fleet fan-out. Additionally:

- **No `/whoami`.** The client learns its own login by other means (see
  "Author labels"). Author labels and presence render logins and handles rather
  than "you".
- **No queue depth in draft rooms.** A draft has no session stream. A draft is
  solo by construction, so the signal has nobody to inform.
- **No pending/sending visual on optimistic messages.** The composer already
  shows "Sending…".

## Server additions

Two changes to `agent-host`, both small, both on the server slice's branch.

### `turnId` on the `message` event

```ts
| { type: "message"; author: string; text: string; ts: string; turnId?: string }
```

`POST /messages` already accepts `turnId`; the broadcast carries it through.
Mirrored into `client/src/lib/types.ts` under the same hand-mirrored contract as
every other `AgentEvent` member.

This exists so a client can recognize its own echo **by identity rather than by
guess**. The sender receives its own `message` on both the turn stream and the
session stream, and without a correlation field the only ways to tell "mine"
from "someone else's" are a text-and-recency heuristic (which fails exactly when
two people paste the same command) or a new identity endpoint (which fails when
one login is connected from two devices).

### `roomKey` for draft rooms

`POST /messages` accepts an optional `roomKey`. The lane becomes:

```
inputId ?? roomKey ?? ""
```

The client sends its existing `draft:<uuid>` tab key. Two people starting a new
chat at the same moment then get distinct lanes instead of sharing the
process-wide `""` bucket, which today can put one person's turn on the other's
lane and hand it that session to resume.

**`roomKey` is client-supplied and becomes a `Map` key, so it is validated:**
`^draft:[0-9a-f-]{36}$`, else 400. Without that guard a client could send a
`roomKey` equal to another room's live session id, land its turn on that lane,
and be handed that session by `laneSession` — the same cross-room failure this
fix closes, triggered deliberately instead of by accident. The draft namespace is
the only lane name a client may choose.

**`subscribers` is deliberately not changed.** The server spec described its `""`
bucket as having the identical limitation. Re-reading it, that bucket is inert:
the client never opens `/sessions//stream` for a draft — it uses the turn stream
— so `subscribers.get("")` is always empty and its re-key is a no-op. The live
collision was only ever in the queue lane and `laneSession`.

## Client state

### Presence and queue depth

`AgentState` gains `presence: string[]` and `queueDepth: number`, per tab, both
reduced from the session stream.

`queueDepth` resets to 0 on session-stream (re)attach. The server re-broadcasts
presence when a subscriber connects but emits depth only on change, so without
the reset a reconnecting client would show a stale "2 waiting" indefinitely.
Presence needs no reset.

### Optimistic entries and reconciliation

`send()` appends the user message immediately, as today, and stamps the
already-generated `turnId` into `TranscriptMessage`'s existing unused `id` field.
That field's doc comment currently says nothing populates it and consumers fall
back to index — it must be updated, since user messages now carry an id while
agent output still does not, and `m.id ?? i` stays the correct key expression.

The reducer then treats `message` as an **upsert keyed by turnId**:

| Case | Behaviour |
|---|---|
| turnId matches an existing entry | Reconcile: adopt the event's `author`, keep everything else local |
| No match | Append as another person's message |
| No turnId | Append |

Keeping the local text is deliberate. The server's `message.text` is the
*prompt*, which `send()` builds by appending `\n\n[Attached files: …]` — adopting
it would replace the sender's attachment chips with a raw path line.

Upsert-by-turnId also makes the sender's double delivery a non-issue. The
existing suppression at `useChatSessions.ts` (turn-stream content is not reduced
once a session stream is attached) already means `message` reaches the reducer
once in both the draft and promoted cases, but an idempotent upsert means the
promotion window cannot produce a duplicate even if that suppression changes.

### Remote attachments

Incoming messages from other people get the `\n\n[Attached files: …]` suffix
parsed off and rendered as chips, exactly like the sender's own. Without this,
your attachments render as chips and everyone else's render as a raw path line in
the same transcript.

The suffix format is produced in exactly one place (`send()` in
`useChatSessions.ts`), so the coupling is real but contained, and a round-trip
test pins it: the string `send()` builds must parse back to the same names.

### Draft room keys

`send()` passes `roomKey` when the tab key starts with `draft:`. Nothing else
changes — the promotion path already swaps to the real session id.

## Presentation

### Author labels

The obvious rule is wrong. "Label when the transcript has ≥2 distinct authors"
fails when you open a room only one other person has spoken in: one distinct
author, no label, and their message reads as yours.

Instead the client learns who it is. **The first `message` event that reconciles
against one of your own optimistic entries carries your login by definition** —
it matched a turnId you generated. Store that as `me`: `App.tsx` state, passed down
to `Transcript` as a prop, learned once per app run rather than per tab. Nothing
is persisted, so it cannot go stale against a changed tailnet login, and no
identity endpoint is added.

Then:

- `author !== me` → label
- `author === me` → no label
- `me` still unknown → label everything

A solo operator sees no labels after their first send. Every multi-person case
labels correctly. The pre-first-send failure mode is one redundant label on your
own message, which self-corrects.

Labels render the roster **handle**, falling back to the full login for anyone no
longer in the allowlist, so a departed teammate still reads correctly in history.

### RoomStrip

A new component rendered above the transcript in `AgentPanel`, returning `null`
unless `presence.length > 1 || queueDepth > 0`. It shows who is present and
"N waiting". Solo and idle, it is not in the DOM — the single-operator client is
unchanged, which is still the common case.

### @-mention autocomplete

The roster is fetched once on connect via a new `get_roster` Rust command and
held as app state passed down as a prop. It is a static list with no event
stream, so it does not warrant a store alongside `registryStore`/`ontologyStore`.

Matching is `/@([A-Za-z0-9._+-]*)$/` against the text **before the cursor**,
filtered case-insensitively by handle prefix. Accepting replaces the token with
`@handle `. Interaction mirrors the existing slash popup exactly — top-match
Enter/Tab accept, arrow-key navigation a deliberate non-goal — because a second
interaction model in the same textarea would be worse than matching mid-message
rather than only at the leading token.

The two popups cannot co-occur: `slashPrefix` requires `^\/\S*$`, which no string
containing a space satisfies. Slash takes precedence if that ever changes.

### 409 in ConfirmationDialog

Both resolve commands currently collapse any non-2xx into a generic error string
in `proxy.rs`. They return the parsed 409 body instead, so the dialog can report
"Already approved by zoe" and drop the item rather than surfacing a raw status.

## Error handling

| Condition | Behaviour |
|---|---|
| `roomKey` not matching the draft pattern | 400 from the agent host; the client never sends another shape |
| Send fails after the optimistic append | Existing behaviour preserved — the message stays visible, the error follows it |
| Session stream reconnects | Presence self-heals from the subscribe broadcast; `queueDepth` resets to 0 |
| `message` with no `turnId` | Appended, never reconciled |
| Author absent from the roster | Label falls back to the full login |
| Queue depth in a draft room | Not shown; drafts have no session stream |
| `me` not yet learned | Every authored message is labelled |

## Testing

**Server**
- `roomKey` validation: the draft pattern is accepted, a session-id-shaped value
  is rejected with 400, absent falls back to `""`
- Lane derivation prefers `inputId` over `roomKey`
- `turnId` appears on the broadcast when the POST carried one, and is absent
  otherwise

**Reducer**
- Upsert-by-turnId reconciles rather than appends; adopts `author`; keeps local
  text and attachments
- A message with an unknown turnId appends
- A message with no turnId appends
- `presence` and `queue` reduce into per-tab state

**Hook** (`useChatSessions`)
- `queueDepth` resets to 0 when a session stream attaches or re-attaches — this
  is the hook's job, not the reducer's
- `send()` includes `roomKey` for a `draft:` tab and omits it for a real session

**Components**
- `RoomStrip` renders nothing when solo and idle; renders presence and depth
  otherwise
- `Transcript` labels a message from another author, does not label `me`, and
  labels everything before `me` is known
- `Composer` @-match against the token before the cursor, accept-on-Enter/Tab,
  and slash precedence
- `ConfirmationDialog` renders the 409 body and drops the item

**Round trip**
- The `[Attached files: …]` string `send()` builds parses back to the same names

## Files

**agent-host** — `src/server.ts`, `src/types.ts`

**client** — new `src/components/RoomStrip.tsx`; `src/lib/types.ts`,
`src/lib/agentEvents.ts`, `src/lib/tauri.ts`, `src/hooks/useChatSessions.ts`,
`src/components/Transcript.tsx`, `src/components/Composer.tsx`,
`src/components/AgentPanel.tsx`, `src/components/ConfirmationDialog.tsx`,
`src/App.tsx`, `src-tauri/src/proxy.rs`

## Follow-ups

- Mention notifications (deferred from the server spec)
- Display names beyond `RHUMB_ALLOWED_USERS` handles
- `queueDepth` for draft rooms, if drafts ever gain a session stream
