# RHUMBR Client Design Spec (Plan 3 of 7)

**Date:** 2026-06-30
**Status:** Approved design (sub-spec of the RHUMBR master spec §3.7–3.9)
**Depends on:** the agent host (Plan 1) and dashboard host (Plan 2) HTTP/SSE contracts.

---

## 1. Role

The **client** is the Tauri v2 desktop app the operator runs on their laptop. Over Tailscale it: talks to the **agent host** (send messages, stream the session), and reads the **dashboard host** registry to render Claude-built surfaces. Scope is the full flexible workspace: a polished agent panel ("Claude desktop feel"), a canvas of surface tabs that can **detach into native windows**, and a connection layer.

**Stack:** Tauri v2 (Rust shell) + React + Vite (TypeScript). New package: `client/`.

## 2. Part 0 — Agent-host enhancement (ships first, its own commit/PR)

The merged agent host cannot stream a brand-new session's turn (the client learns the session id only from the stream, but must subscribe before the turn runs; the pending `""` bucket is unreachable and cross-talks). Fix with a small **additive, non-breaking** change in `agent-host/`:

- `POST /messages` accepts an optional client-generated `turnId` (string) alongside `prompt`/`sessionId`.
- New `GET /turns/:turnId/stream` (SSE) subscribes to that turn's events.
- When a turn carries a `turnId`, the host fans its `AgentEvent`s (including the `session` event with the real id) to that turn's subscribers, keyed by `turnId` — uniform for new and resumed sessions, no cross-talk.
- `/sessions/:id/stream` and the existing behavior stay (non-breaking).
- TDD in the agent-host package (Supertest): a turn streamed by `turnId` delivers the `session` then `result` events to a `/turns/:turnId/stream` subscriber.

The client always uses the turn-scoped flow: generate `turnId` → open `/turns/:turnId/stream` → POST `{ turnId, prompt, sessionId? }`.

## 3. Architecture

**Rust proxies the entire control plane; the webview never makes cross-origin calls to the tailnet** (so no CORS is needed on the hosts). Surface *content* loads directly into iframes/windows (navigation governed by CSP/capabilities, not CORS).

### 3.1 Rust side (`client/src-tauri/`)

- `config.rs` — load/save the two tailnet base URLs (`agentBase`, `dashboardBase`) to a Tauri app-data file; expose `get_config` / `set_config` commands; `check_health(base)` hits `/healthz`.
- `sse.rs` — **pure** SSE frame parser: feed it raw bytes/chunks, it yields complete `data:` JSON payloads. Unit-tested in isolation (no network).
- `agent.rs` — `send_message(turnId, prompt, sessionId?)` (POST to `agentBase/messages`); `start_agent_stream(turnId)` opens `agentBase/turns/:turnId/stream`, parses via `sse.rs`, emits Tauri events `agent://{turnId}` (one per `AgentEvent`); `stop_agent_stream(turnId)`.
- `registry.rs` — `get_registry()` (GET `dashboardBase/registry`); `start_registry_stream()` opens `dashboardBase/registry/stream`, emits `registry://update` with each snapshot; `stop_registry_stream()`.
- `windows.rs` — `open_surface_window(id, url)` creates a `WebviewWindow` loading the surface URL with IPC disabled; `close_surface_window(id)`.
- `main.rs` — registers commands, capabilities, CSP.

### 3.2 React side (`client/src/`)

The app shell is the **only** context with `invoke`/IPC access.

- `lib/config.ts` — typed wrappers over the config commands; first-run detection.
- `lib/agentEvents.ts` — **pure** reducer: `(state, AgentEvent) => state` building a transcript view model. Maps `session` → set current session id; `result` → a result message; `error` → an error message; `text`/`raw` → message or collapsible tool-call card (best-effort: a `raw` SDK assistant message with `tool_use` content → a tool card; with text → a text message). Unit-tested.
- `lib/registryStore.ts` — **pure** reducer over `RegistryEvent` snapshots → the tab list (id, title, url). Unit-tested.
- `lib/session.ts` — local session tracking: the client persists sessions it created (`{ id, title (first prompt), createdAt }`) to app storage, since the host has no session-list API; drives the sidebar and resume.
- `components/ConnectionScreen.tsx` — enter/verify the two hosts; shown until both `/healthz` pass.
- `components/AgentPanel.tsx` — session sidebar + transcript (from `agentEvents`) + input. Subscribes to `agent://{turnId}` Tauri events.
- `components/Canvas.tsx` — tab strip (from `registryStore`) + the active surface `<iframe>` + a **detach** control calling `open_surface_window`. Subscribes to `registry://update`.
- `components/Workspace.tsx` — the resizable agent-left / canvas-right split; default layout.
- `App.tsx` — connection gating, top-level wiring of the streams.

## 4. Data flow

**New/continued turn:** user submits → React generates `turnId` → `start_agent_stream(turnId)` (open SSE first) → `send_message(turnId, prompt, sessionId?)` → Rust streams `AgentEvent`s → `agent://{turnId}` → `agentEvents` reducer → transcript. The `session` event records the real session id (new or resumed) into local session tracking.

**Surface appears:** agent writes `<workspace>/surfaces/<id>/` → dashboard host pushes a registry snapshot → Rust `registry://update` → `registryStore` adds a tab → the iframe loads `dashboardBase/surfaces/<id>/`.

**Detach:** detach button → `open_surface_window(id, dashboardBase/surfaces/<id>/)` → native `WebviewWindow`; the tab shows a "detached" state; re-dock closes the window and restores the inline iframe.

## 5. Security

- Surface content is agent-generated and treated as untrusted: it loads in iframes and `WebviewWindow`s with **no Tauri IPC/API access**.
- CSP allows the configured tailnet origins as `frame-src`/navigation and `connect-src` for the Rust-side fetches only; it does not grant remote origins native capability access.
- The Rust proxy is the sole network boundary for the control plane; the shell webview calls only Tauri commands.
- No credentials live in the client (the agent host holds the Claude subscription token). The client only knows the two tailnet base URLs.

## 6. Error handling

- A host failing `/healthz` keeps the connection screen up with a clear message; reconnect on fix.
- A dropped agent or registry SSE stream is retried by the Rust side with backoff; the UI shows a "reconnecting" indicator and resumes (the registry stream re-emits a full snapshot on reconnect; the agent stream is per-turn, so a drop ends that turn with an error message).
- An `error` `AgentEvent` renders as an error message in the transcript, not a crash.
- A surface whose iframe fails to load shows an inline error in that tab; other tabs are unaffected.

## 7. Testing

- **Rust:** `sse.rs` parser unit tests (partial chunks, multiple frames, blank-line termination). `config.rs` load/save round-trip.
- **TS (Vitest):** `agentEvents` reducer (session/result/error/text/tool-card mappings); `registryStore` reducer (add/replace/remove tabs from snapshots); `session.ts` tracking (dedupe, persistence shape).
- **Thin Tauri glue** (commands, window creation, event emission) is verified by running the app end-to-end against the two hosts, not unit-tested.

## 8. Scope / out of scope

- **In:** Part 0 agent-host change; Rust proxy + SSE bridge; the agent panel (transcript, tool cards, session sidebar, resume); the canvas (registry tabs, iframe rendering, detach to native window, re-dock); connection screen; resizable split.
- **Out (later plans):** data endpoint / live data (Plan 4); infra capability (5); spawned `service` surfaces (6 — canvas renders only `file` surfaces today); ontology (7); multi-user; auto-update.
