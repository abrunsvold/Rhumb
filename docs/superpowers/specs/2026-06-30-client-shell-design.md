# Rhumb Client Shell Design Spec (Plan 3b of 7)

**Date:** 2026-06-30
**Status:** Approved design (completes the client design spec `2026-06-30-client-design.md`).
**Depends on:** the agent host (Plan 1 + turn streaming from 3a), the dashboard host (Plan 2), and the `client/` foundation modules (3a: `agentEvents`, `registryStore`, `session`, `types`).

Grounded against live Tauri v2 docs (commands, Channels, capabilities, `WebviewWindow`). Build prerequisites confirmed present on the dev Mac (cargo 1.95, rustc 1.95, Xcode CLT, Node 24).

---

## 1. Role

Plan 3b adds the Tauri v2 desktop shell, a Rust control-plane proxy, and the React UI on top of the 3a foundation — producing the runnable Rhumb client: a flexible workspace with a "Claude-desktop-feel" agent panel and a canvas of surface tabs that detach into native windows.

## 2. Architecture

The React webview is the only context with IPC (`invoke`) access. The Rust side proxies all control-plane HTTP/SSE to the two tailnet hosts (so no CORS is needed on them). Surface *content* loads directly into iframes / native windows (navigation governed by CSP + capabilities, never IPC).

### 2.1 Rust proxy (`client/src-tauri/src/`)

- `config.rs` — `AppConfig { agent_base: String, dashboard_base: String }`; load/save to the app-config dir (`tauri::Manager::path`); commands `get_config`, `set_config(config)`, `check_health(base) -> bool` (GET `base/healthz`).
- `sse.rs` — **pure** incremental SSE parser: `SseParser::push(chunk: &str) -> Vec<String>` returns the JSON payloads of any `data:` frames completed by that chunk (frames end on a blank line). No I/O; unit-tested.
- `agent.rs`:
  - `send_message(agent_base, turn_id, prompt, session_id: Option<String>)` — POST `agent_base/messages` with `{ turnId, prompt, sessionId? }`.
  - `start_agent_stream(agent_base, turn_id, on_event: Channel<serde_json::Value>)` — GET `agent_base/turns/:turn_id/stream`, feed the body through `SseParser`, `on_event.send(payload)` per frame. Registered in a `turn_id -> CancellationToken` map (Tauri-managed state) so `stop_agent_stream(turn_id)` aborts it.
- `registry.rs`:
  - `get_registry(dashboard_base) -> serde_json::Value` — GET `dashboard_base/registry`.
  - `start_registry_stream(dashboard_base, on_update: Channel<serde_json::Value>)` + `stop_registry_stream()` — GET `dashboard_base/registry/stream`, emit each snapshot.
- `lib.rs` — `run()` builds the app: manages the cancellation-token state and config, registers all commands via `generate_handler!`.

The streaming commands use Tauri **Channels** (`tauri::ipc::Channel<T>`), the recommended ordered-streaming primitive — not `emit`/`listen`.

### 2.2 React UI (`client/src/`)

- `lib/tauri.ts` — thin typed wrappers over `invoke`/`Channel` (`getConfig`, `setConfig`, `checkHealth`, `sendMessage`, `openAgentStream(turnId, onEvent)`, `getRegistry`, `openRegistryStream(onUpdate)`). Centralizes all IPC so components stay testable with this module mocked.
- `components/ConnectionScreen.tsx` — form for `agentBase`/`dashboardBase`; verifies both via `checkHealth`; persists via `setConfig`. Shown until both pass.
- `components/AgentPanel.tsx` — session sidebar (`session.ts`), transcript (`reduceAgent` fed by the agent Channel), input. Submitting generates a `turnId` (`crypto.randomUUID()`), opens the stream, then sends the message; the `session` event records the resolved session id via `addSession`.
- `components/Canvas.tsx` — tab strip (`reduceRegistry` fed by the registry Channel); active surface in a sandboxed `<iframe src={dashboardBase + tab.url}>`; a **detach** control creating `new WebviewWindow('surface:' + id, { url, title })`; re-dock closes that window.
- `components/Workspace.tsx` — resizable agent-left / canvas-right split.
- `App.tsx` — connection gating; opens the registry stream on connect; renders `Workspace`.

### 2.3 Tauri config & security

- `tauri.conf.json` — one window `main`; CSP allowing `frame-src` for http/https (so iframes can load the runtime-configured tailnet origin) plus `connect-src 'self' ipc:` for the shell; `withGlobalTauri` off.
- `capabilities/main.json` — grants the `main` window exactly the core/permission set the shell needs (the registered commands, window APIs used). **Detached surface windows use `surface:*` labels that appear in NO capability file → they receive zero Tauri API access.**
- Docked-surface iframes carry a `sandbox` attribute (allow scripts + same-origin for the surface to call its own data endpoint later, but no top-navigation/popups).

## 3. Data flow

**Turn:** submit → `turnId = randomUUID()` → `openAgentStream(turnId, onEvent)` (opens the Channel + SSE) → `sendMessage(turnId, prompt, sessionId?)` → Rust streams frames → Channel `onmessage` → `reduceAgent` → transcript; `session` event → `addSession`.

**Surface appears:** agent writes a surface folder → dashboard host pushes a registry snapshot → registry Channel → `reduceRegistry` → new tab → iframe loads `dashboardBase + /surfaces/<id>/`.

**Detach / re-dock:** detach → `new WebviewWindow('surface:'+id, { url })`; the tab marks itself detached; re-dock → `getWebviewWindow('surface:'+id)?.close()` and restore the iframe.

## 4. Carry-in fixes from the 3a review

- **Agent host:** reap empty `turnSubscribers` / `subscribers` map entries — when a turn's subscriber set empties on disconnect (and after the turn completes), delete the key. Add a Supertest/unit assertion that a closed turn stream leaves no residual map entry.
- **Reducer:** `reduceAgent` should surface a `result` with `isError: true` as `kind: "error"` (or carry an `isError` flag) so a failed result doesn't render as success. Update `agentEvents.ts` + its tests.

## 5. Error handling

- A host failing `check_health` keeps the connection screen up with the failing base named.
- A dropped registry stream is retried by the Rust side with backoff; on reconnect the dashboard host re-emits a full snapshot, so the tab list self-heals. A dropped agent stream ends that turn with an error message in the transcript (turns are short-lived).
- An `error` `AgentEvent` renders as an error message, never a crash.
- A surface iframe that fails to load shows an inline error in that tab only.

## 6. Testing & verification (hybrid)

**Automated (subagent-run):**
- Rust: `sse.rs` parser unit tests (partial chunks, multiple frames, blank-line termination); `config.rs` load/save round-trip. `cargo test`.
- TS: component tests (Vitest + Testing Library + jsdom) for `ConnectionScreen` (health gating), `AgentPanel` (transcript renders from fed events; submit triggers stream-then-send in order), `Canvas` (tabs render; detach calls the window API) — with `lib/tauri.ts` mocked.
- Typecheck (`tsc`) + a clean `tauri build` (or `cargo build` + `vite build`) as the integration gate.

**Live run (driver-verified):** after the automated gate, the running app is verified end-to-end via computer-use on the dev Mac — **local-first**: run agent-host + dashboard-host on `localhost`, drop a test surface, send a message, screenshot the streamed transcript and a rendered + detached surface; **then** repoint config at the Proxmox deployment over Tailscale. (Requires the two hosts running; the agent host needs a real `CLAUDE_CODE_OAUTH_TOKEN` for the full agent path, but the dashboard/canvas path can be verified without it.)

## 7. Scope / out of scope

- **In:** Tauri v2 scaffold; Rust proxy (config, sse parser, agent + registry commands, Channel streaming, cancellation); the four React components + `lib/tauri.ts`; capabilities/CSP security; the two carry-in fixes; automated tests + the driven live run.
- **Out (later plans):** data endpoint / live data + write-back (Plan 4); infra capability (5); spawned `service` surfaces + reverse proxy (6 — canvas renders only `file` surfaces); ontology (7); auto-update; packaging/signing for distribution; multi-user.
