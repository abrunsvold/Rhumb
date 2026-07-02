# Client UI — Full UX Pass (Design)

Date: 2026-07-01
Status: Approved

## Problem

The Tauri client shell (`client/`) was built as a functional skeleton with no
visual design: there is no stylesheet anywhere, components render as
browser-default HTML, and several layout defaults make the app look broken —
the surface iframe renders at the browser default ~300×150px, the chat
transcript has no scroll container, and the user's own messages never appear
in the transcript (the reducer has no `user` message kind).

## Goal

Make the client look and behave like a real desktop tool: dark, dense,
tool-like visual style, plus the UX behaviors a chat-driven operator app
needs (visible user messages, streaming indicator, keyboard submit, empty and
error states, a way to disconnect and change hosts, slash-command
autocomplete, and file attachments that land in the agent's workspace).

## Non-goals

- Markdown rendering of assistant text.
- Light theme / system-theme switching (dark only).
- Drag-to-reorder tabs, tab closing, or surface lifecycle management.
- CSP changes (`style-src 'unsafe-inline'` remains; Vite dev mode injects
  styles inline).
- Multipart upload, resumable upload, or upload progress UI (single JSON
  request per file, ≤ 20 MB).
- Slash-command discovery before the first turn (the SDK only reports the
  command list at session init).

## Approach

Tailwind CSS v4 via the `@tailwindcss/vite` plugin (dev dependencies:
`tailwindcss`, `@tailwindcss/vite`). A single `src/app.css` contains
`@import "tailwindcss"` and an `@theme` block defining design tokens:

- Palette: dark charcoal surface stack (page, raised panel, border), one
  accent color for primary actions and user messages, red for errors.
- Type: system UI font stack; monospace for tool chips, host URLs, and op
  JSON.
- Density: compact spacing consistent with an operator tool.

`main.tsx` imports `app.css`. All existing inline `style={}` props move to
Tailwind classes.

## Components

### App shell (`App.tsx`, `Workspace.tsx`)

- Slim top status bar: app name, connected agent/dashboard host URLs
  (truncated, monospace), and a **Disconnect** button.
- Disconnect clears persisted config by calling
  `setConfig({ agentBase: "", dashboardBase: "" })` and resets App state so
  the ConnectionScreen shows again. `App` passes an `onDisconnect` callback
  into the shell.
- Below the bar, the existing horizontal split: chat pane at 40% width with a
  min-width and the native CSS `resize: horizontal` handle (styled), canvas
  pane taking the rest. Full viewport height, no page scroll.

### Chat (`AgentPanel.tsx`, `lib/agentEvents.ts`)

- `TranscriptMessage.kind` gains `"user"`. On submit, the panel appends the
  user's message to the transcript locally (the agent stream never echoes
  it).
- Busy state: the panel tracks in-flight turns; while any turn is open, a
  "thinking…" indicator renders at the end of the transcript. Cleared on
  `result`/`error`.
- Message rendering by kind:
  - `user` — right-aligned accent bubble.
  - `text` (assistant) — plain left-aligned text block.
  - `tool` — compact monospace chip (`🔧 name`); clicking toggles a
    collapsed/expanded view of the tool input JSON.
  - `error` — red text block.
  - `result` — subtle end-of-turn divider with muted text.
- Transcript is the scrollable flex-fill region with stick-to-bottom
  auto-scroll: on new messages, scroll to bottom only if the user was already
  at (or near) the bottom.
- Empty state: "Send a message to start a session."
- Composer pinned at the bottom: auto-growing textarea (1–8 rows), Enter
  sends, Shift+Enter inserts a newline, Send button disabled when the draft
  is empty and no attachments are staged. Concurrent turns remain allowed
  (existing behavior).

### Slash commands (`AgentPanel.tsx`, `agent-host`)

Slash commands already work end-to-end: the host passes the prompt string
verbatim to the Agent SDK, which expands `/command` against the workspace's
installed skills. The client adds discovery and rendering:

- The SDK's `system`/`init` message carries a `slash_commands` array. The
  agent-host `SessionManager` extends its `session` event to
  `{ type: "session", sessionId, slashCommands?: string[] }` (field omitted
  when the SDK does not report it). `reduceAgent` stores the list on
  `AgentState`.
- Composer autocomplete: when the draft starts with `/`, a popup above the
  composer lists matching commands (prefix filter). Arrow keys + Enter or
  Tab select; Escape dismisses; clicking inserts. Before the first turn the
  list is empty and the popup does not render — typing a command still sends
  it.
- User messages starting with `/` render the leading `/command` token in
  monospace command styling.

### File attachments (`AgentPanel.tsx`, `src-tauri/proxy.rs`, `agent-host`)

"Upload" means placing the file in the agent's workspace so it can read it
like any other file:

- **agent-host** — `POST /files` with JSON `{ name, contentBase64 }`, behind
  the existing control-token guard. Writes to `<workspace>/uploads/`,
  creating the directory on demand. The stored filename is sanitized to a
  safe basename (no path separators or leading dots) and collision-suffixed
  (`report.csv`, `report-2.csv`, …). Requests over 20 MB decoded are
  rejected with 413; the JSON body limit for this route is raised
  accordingly. Responds `{ path: "uploads/<name>" }` (workspace-relative).
- **Rust proxy** — new `upload_file(agent_base, name, content_base64)`
  command following the existing JSON-post command pattern (bearer token
  from persisted config), returning the stored path.
- **Chat UI** — an attach button (file input) and drag-and-drop onto the
  composer stage files as removable chips (kept in memory as bytes +
  filename). On send: each staged file uploads first; the prompt gains a
  trailing block `[Attached files: uploads/a.csv, uploads/b.png]`; the user
  bubble shows attachment chips. Upload failure aborts the send and surfaces
  an error message in the transcript; the draft and attachments stay staged.

### Canvas (`Canvas.tsx`)

- Tab bar: styled tab buttons with a distinct active state,
  `overflow-x: auto` for many tabs; Detach button right-aligned in the bar.
- The iframe fills the remaining pane height/width (fixes the default
  ~300×150px size). Sandbox attributes and the detach capability comment are
  unchanged.
- Empty state when no surfaces exist: "No surfaces yet — the agent will
  publish dashboards here."

### Connection screen (`ConnectionScreen.tsx`)

- Centered card on the dark page background: title, one-line explanation,
  three labeled inputs with placeholders (`http://localhost:…` for hosts),
  the token input stays `type="password"`.
- Enter in any field submits; the Connect button shows a busy label while
  health checks run; the error message renders as a styled alert
  (keeps `role="alert"`).

### Confirmation dialog (`ConfirmationDialog.tsx`)

- Same overlay/card structure, restyled with classes (no inline styles).
- Op JSON in a monospace scrollable block.
- Approve = accent button, Deny = neutral button.
- When more than one item is queued, show a "N pending" badge in the card
  header.

## Data flow changes

1. `reduceAgent` / `TranscriptMessage`: new `"user"` kind (with optional
   attachment names), appended by the panel on submit (not produced by any
   stream event).
2. `App` → shell `onDisconnect` callback clearing config via the existing
   `set_config` IPC command.
3. `session` events optionally carry `slashCommands`; `AgentState` stores
   the latest list.
4. New upload path: composer → `upload_file` IPC → Rust proxy →
   `POST /files` on the agent-host → workspace `uploads/` directory.

## Error handling

- Stream `error` events already reduce into the transcript; they render in
  the error style.
- Health-check failure on connect keeps the existing message and `role="alert"`.
- Disconnect performs no health calls and cannot fail visibly; if
  `set_config` rejects, the app still returns to the ConnectionScreen (state
  reset is unconditional).

## Testing

Vitest + Testing Library (already configured). Existing tests must keep
passing; queries are role-based so restyling should not break them.

New tests:

- Submitting appends a `user` message to the transcript.
- Enter submits; Shift+Enter does not.
- Disconnect returns to the ConnectionScreen and calls `set_config` with
  empty hosts.
- Canvas renders the empty state when the registry has no tabs.
- Slash autocomplete: popup lists prefix matches from the session's command
  list; selection inserts the command; no popup when the list is empty.
- Attachments: staged chips render and can be removed; send uploads staged
  files and appends the `[Attached files: …]` block to the prompt; upload
  failure keeps the draft and shows an error.
- agent-host `POST /files`: writes a sanitized, collision-suffixed file
  under `uploads/`, rejects >20 MB and path-traversal names, requires the
  control token when configured; `session` events include `slashCommands`
  when the SDK init message reports them.

Verification beyond unit tests: `npm run typecheck`, `npm run build`, and a
manual `npm run tauri:dev` smoke check of the connect → chat → surface flow.
