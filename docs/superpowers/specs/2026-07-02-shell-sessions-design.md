# Platform Shell + First-Class Sessions (Design)

Date: 2026-07-02
Status: Approved

## Problem

The client is a single implicit conversation wrapped in a fixed split. There
is no session list, no way to resume yesterday's conversation, no parallel
sessions, and no navigation frame for the platform views coming next
(operator console, surface workspace). The agent-host can already resume any
session by id and streams per-session events at `/sessions/:id/stream`, but
nothing indexes sessions and nothing serves history.

This is phase 1 of the "modern platform" sequence agreed on 2026-07-02:
1. **Shell + sessions (this spec)**
2. Operator console (services / infra / approvals / audit views)
3. Surface workspace (grid/split/pin layouts)
4. Polish layer (command palette, toasts, settings)

## Goal

A navigation shell that frames the platform, and sessions as durable,
named, parallel first-class objects: list them, resume them with full
history, run several at once in live chat tabs.

## Non-goals

- Console views, surface layouts, command palette (later phases).
- Split chat panes (two sessions visible at once).
- Session search or filtering beyond newest-first + archived-hidden.
- Deleting SDK transcripts from disk (archive hides from the index only).
- Multi-operator concerns; single-operator model unchanged.

## Shell

- **Icon rail** (fixed, ~48px, left edge): Sessions, Surfaces, and a gear.
  Console icons arrive in phase 2. Active icon highlighted.
- **Panel** (~260px, collapsible; rail click toggles): hosts the sessions
  list or the surfaces list; the gear shows connection info (host URLs,
  monospace) and the Disconnect button. The current top status bar is
  removed — its contents move here.
- **Main area** keeps the chat+canvas split. The chat pane gains a tab
  strip of open sessions.
- The Surfaces panel lists registry entries (same data as canvas tabs);
  clicking focuses that canvas tab. Canvas behavior is otherwise unchanged
  this phase.

## agent-host: session service

New `agent-host/src/sessions.ts` + routes in `server.ts` (all behind the
existing control-token guard):

- **Index** at `<workspace>/sessions.json`: array of
  `{ id, title, createdAt, lastActiveAt, preview, archived }`.
  Upserted whenever a turn emits a `session` event: created with
  auto-title = first prompt truncated to 60 chars (word-boundary, ellipsis),
  `preview` = same truncation, `lastActiveAt` bumped on every turn.
  Writes are atomic (temp file + rename).
- `GET /sessions` → `{ sessions: [...] }` newest-`lastActiveAt` first,
  archived excluded; `?archived=1` includes them.
- `GET /sessions/:id/transcript` → `{ messages: [...] }` parsed from the
  SDK's stored session JSONL into the client's `TranscriptMessage` shapes
  (`user`, `text`, `tool`, `result`, `error`), reusing the extraction rules
  the client reducer applies to live events. Parsing is defensive: unknown
  record types are skipped, a missing/corrupt file yields 404.
- `PATCH /sessions/:id` body `{ title }` → rename (1–120 chars).
- `POST /sessions/:id/archive` → sets `archived: true`.

The transcript parser is the one piece coupled to SDK on-disk format;
it lives isolated in `sessions.ts` with fixture-based tests so format
drift breaks loudly in one place.

## Client: sessions panel

- List rows: title, relative last-active time, badges — running (accent
  pulse) while any turn is open, unread (dot) when a background tab
  received events since last focus.
- **New session** button opens an empty chat tab immediately (no server
  call until the first send).
- Inline rename (double-click title → input → PATCH); archive via hover
  action with no confirm (index-only, reversible by `?archived=1` later).

## Client: chat tabs, multiple live

- Chat state becomes a keyed store: `Map<sessionKey, AgentState>`.
  A new session tab keys by a temp id (`draft:<uuid>`); the first `session`
  event promotes it to the real id (store re-key, tab title refresh).
- Opening an existing session: hydrate via `get_transcript`, then attach a
  live session stream (`start_session_stream`). Hydration then live events
  append; no dedup pass is attempted this phase (the SDK transcript ends
  before the stream attaches; a turn racing the open may duplicate its
  tail — accepted, noted for phase-2 hardening if observed).
- Sending inside a tab keeps today's stream-first turn flow (turn streams
  for in-flight turns) unchanged.
- Background tabs keep their session streams: events reduce into their
  state and set the unread badge. Closing a tab stops its stream only;
  the server-side session is untouched.
- The tab strip shows title (truncated), running spinner, unread dot, and
  a close button. Overflow scrolls horizontally.

## Rust proxy

New commands following the existing pinned-host + bearer pattern:
`list_sessions`, `get_transcript(session_id)`, `rename_session(session_id,
title)`, `archive_session(session_id)`, and
`start_session_stream(session_id, channel)` / `stop_session_stream(session_id)`
managed in `StreamState` like turn streams (map keyed by session id).

## Error handling

- Transcript 404/parse failure → tab opens empty with an inline muted
  notice "History unavailable for this session"; chatting still works.
- Session stream drop → badge turns stale-gray; auto-retry with backoff;
  recovered stream clears the state.
- Rename/archive failures surface as a toast-less inline shake + revert
  (no toast system yet this phase).

## Testing

- **agent-host**: index upsert/create/bump ordering, title truncation,
  atomic write, guard on all new routes, transcript parsing from JSONL
  fixtures (happy, unknown-record, corrupt-file), rename/archive
  validation.
- **client**: panel renders list with badges; new-session temp-key
  promotion on first session event; open-tab hydration renders fetched
  history; background event sets unread; close detaches stream; rename
  PATCH wiring; keyed-store reducer isolation between sessions.
- **Rust**: existing suite + compile; stream-map add/remove unit coverage
  mirroring turn-stream tests if present.
- Manual: two live tabs with concurrent turns against the real host;
  restart client and resume with history.
