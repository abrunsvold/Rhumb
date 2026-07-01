# Rhumb Client Shell Implementation Plan (Plan 3b of 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the runnable Rhumb client — a Tauri v2 desktop shell with a Rust control-plane proxy (Channel-streamed SSE) and a React UI (connection screen, agent panel, canvas with detachable surfaces) on top of the 3a foundation.

**Architecture:** The React webview is the only IPC context; the Rust side proxies all HTTP/SSE to the two tailnet hosts (no CORS needed). Streaming uses Tauri Channels. Detached surfaces are native `WebviewWindow`s whose labels appear in no capability, so they get zero IPC.

**Tech Stack:** Tauri v2 (Rust), React 18 + Vite + TypeScript, Vitest (+ jsdom + Testing Library for components), `cargo test` for Rust.

## Global Constraints

- **Grounded Tauri v2 facts:** commands are `#[tauri::command]` + `generate_handler!`, invoked via `invoke` from `@tauri-apps/api/core`; streaming Rust→JS uses `tauri::ipc::Channel<T>` (JS `new Channel(); ch.onmessage = …`); runtime windows via `new WebviewWindow(label, { url, title })` from `@tauri-apps/api/webviewWindow`; capabilities are JSON files in `src-tauri/capabilities/` targeting windows by **label**.
- **Security (config-enforced):** the `main` window gets a capability with only the permissions the shell needs; **detached surface windows use `surface:*` labels that are in NO capability file** → zero Tauri API access. Surface iframes carry a `sandbox` attribute.
- **No hand-written Tauri schema:** scaffold `src-tauri/` with the Tauri CLI (`tauri init`) so `tauri.conf.json`/`Cargo.toml` are canonical; then apply the specific edits this plan names. Verify with `cargo build`.
- **IPC isolation for testability:** all `invoke`/`Channel` calls live in `client/src/lib/tauri.ts`; components are tested with that module mocked.
- **Arg casing:** Tauri v2 converts camelCase JS `invoke` arg keys to snake_case Rust command params, so `lib/tauri.ts` uses camelCase keys (`agentBase`, `turnId`, `dashboardBase`, `sessionId`) mapping to `agent_base`, `turn_id`, etc. If the live run shows a Rust param arriving empty/None, that conversion is the cause — align the JS key to the installed CLI's convention. (Component tests mock `lib/tauri`, so this surfaces only in the driven run.)
- **Reuse the 3a foundation:** `reduceAgent`/`AgentState` (agentEvents), `reduceRegistry`/`Tab` (registryStore), `addSession`/`TrackedSession` (session), and the `AgentEvent`/`RegistrySnapshot` types already exist and are tested — import them, don't reimplement.
- **Node ≥ 20, TS strict, ES modules.** Local TS imports in `client/` use no `.js` suffix (bundler resolution).

---

### Task 1: Carry-in fix — reducer surfaces `result.isError`

**Files:**
- Modify: `client/src/lib/agentEvents.ts`
- Modify: `client/test/agentEvents.test.ts`

**Interfaces:**
- Produces (unchanged signatures): `reduceAgent(state, event)`. A `result` event with `isError: true` now yields a message with `kind: "error"`; with `isError: false`, `kind: "result"` (as before).

- [ ] **Step 1: Add the failing test** — append to `client/test/agentEvents.test.ts` inside the `describe("reduceAgent", ...)` block:

```typescript
  it("renders an errored result as an error message", () => {
    const s = run([{ type: "result", result: "failed run", isError: true }]);
    expect(s.messages).toEqual([{ kind: "error", text: "failed run" }]);
  });

  it("still renders a successful result as a result message", () => {
    const s = run([{ type: "result", result: "done", isError: false }]);
    expect(s.messages).toEqual([{ kind: "result", text: "done" }]);
  });
```

- [ ] **Step 2: Run the test to verify the new errored-result test fails**

Run: `cd client && npx vitest run test/agentEvents.test.ts`
Expected: FAIL — the errored result currently maps to `kind: "result"`.

- [ ] **Step 3: Update the `result` branch** in `client/src/lib/agentEvents.ts`:

Replace:

```typescript
    case "result":
      return { ...state, messages: [...state.messages, { kind: "result", text: event.result }] };
```

with:

```typescript
    case "result":
      return {
        ...state,
        messages: [
          ...state.messages,
          { kind: event.isError ? "error" : "result", text: event.result },
        ],
      };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run test/agentEvents.test.ts`
Expected: PASS (all existing tests plus the two new ones).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/agentEvents.ts client/test/agentEvents.test.ts
git commit -m "fix(client): render errored results as error messages"
```

---

### Task 2: Carry-in fix — agent host reaps empty subscriber entries

**Files:**
- Modify: `agent-host/src/server.ts`
- Modify: `agent-host/test/server.test.ts`

**Interfaces:**
- Produces: `pruneSubscriber(map: Map<string, Set<import("express").Response>>, id: string, res: import("express").Response): void` (exported from `server.ts`) — removes `res` from the set for `id` and deletes the key if the set becomes empty. Both stream routes call it from `req.on("close")`.

- [ ] **Step 1: Add the failing test** — append to `agent-host/test/server.test.ts` inside the `describe("agent-host server", ...)` block (and add `pruneSubscriber` to the existing import from `../src/server.js`):

```typescript
  it("pruneSubscriber keeps the entry while other subscribers remain, deletes it when empty", () => {
    const a = {} as import("express").Response;
    const b = {} as import("express").Response;
    const map = new Map<string, Set<import("express").Response>>();
    map.set("t9", new Set([a, b]));

    pruneSubscriber(map, "t9", a);
    expect(map.get("t9")?.has(b)).toBe(true); // still present

    pruneSubscriber(map, "t9", b);
    expect(map.has("t9")).toBe(false); // key reaped when empty
  });

  it("pruneSubscriber is a no-op for an unknown id", () => {
    const map = new Map<string, Set<import("express").Response>>();
    expect(() => pruneSubscriber(map, "missing", {} as import("express").Response)).not.toThrow();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd agent-host && npx vitest run test/server.test.ts`
Expected: FAIL — `pruneSubscriber` is not exported.

- [ ] **Step 3: Add the helper and use it in both routes** in `agent-host/src/server.ts`.

Add this exported helper near the top (next to `subsFor`):

```typescript
export function pruneSubscriber(
  map: Map<string, Set<Response>>,
  id: string,
  res: Response,
): void {
  const set = map.get(id);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) map.delete(id);
}
```

In the `/sessions/:id/stream` handler, replace:

```typescript
    const set = subsFor(subscribers, req.params.id);
    set.add(res);
    req.on("close", () => set.delete(res));
```

with:

```typescript
    const id = req.params.id;
    subsFor(subscribers, id).add(res);
    req.on("close", () => pruneSubscriber(subscribers, id, res));
```

In the `/turns/:turnId/stream` handler, replace:

```typescript
    const set = subsFor(turnSubscribers, req.params.turnId);
    set.add(res);
    req.on("close", () => set.delete(res));
```

with:

```typescript
    const turnId = req.params.turnId;
    subsFor(turnSubscribers, turnId).add(res);
    req.on("close", () => pruneSubscriber(turnSubscribers, turnId, res));
```

- [ ] **Step 4: Run the full agent-host suite + typecheck**

Run: `cd agent-host && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add agent-host/src/server.ts agent-host/test/server.test.ts
git commit -m "fix(agent-host): prune empty subscriber map entries on disconnect"
```

---

### Task 3: Tauri v2 scaffold + Rust SSE parser

**Files:**
- Create (via CLI): `client/src-tauri/` (Cargo.toml, tauri.conf.json, capabilities/, src/lib.rs, src/main.rs, build.rs)
- Modify: `client/package.json` (tauri scripts + CLI devDependency)
- Create: `client/src-tauri/src/sse.rs`
- Test: Rust unit tests inside `sse.rs`

**Interfaces:**
- Produces: `pub struct SseParser` with `pub fn new() -> Self` and `pub fn push(&mut self, chunk: &str) -> Vec<String>` — accumulates input and returns the JSON payload string of each `data:` frame completed by this chunk (a frame ends at a blank line `\n\n`).

- [ ] **Step 1: Add the Tauri CLI and scripts to `client/package.json`**

Add to `devDependencies`: `"@tauri-apps/cli": "^2.0.0"`. Add to `dependencies`: `"@tauri-apps/api": "^2.0.0"`. Add scripts:

```json
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build"
```

Run: `cd client && npm install`
Expected: exit 0.

- [ ] **Step 2: Scaffold src-tauri with the Tauri CLI (non-interactive)**

Run:

```bash
cd client && npx tauri init --ci \
  --app-name rhumb \
  --window-title "Rhumb" \
  --frontend-dist ../dist \
  --dev-url http://localhost:5173 \
  --before-dev-command "npm run dev" \
  --before-build-command "npm run build"
```

Expected: creates `client/src-tauri/` with `Cargo.toml`, `tauri.conf.json`, `src/`, `capabilities/default.json`, `build.rs`. (If a flag name differs on the installed CLI version, run `npx tauri init --help`, map to the equivalent flags, and accept the generated layout — the canonical scaffold is the goal.)

- [ ] **Step 3: Verify the scaffold builds**

Run: `cd client/src-tauri && cargo build`
Expected: compiles (downloads crates on first run); exit 0.

- [ ] **Step 4: Write the SSE parser with failing tests** — create `client/src-tauri/src/sse.rs`:

```rust
/// Incremental Server-Sent-Events parser. Feed it chunks; it returns the JSON
/// payload of each `data:` frame completed by that chunk. Frames end on a blank line.
pub struct SseParser {
    buf: String,
}

impl SseParser {
    pub fn new() -> Self {
        SseParser { buf: String::new() }
    }

    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        // Frames are separated by a blank line ("\n\n").
        while let Some(idx) = self.buf.find("\n\n") {
            let frame: String = self.buf[..idx].to_string();
            self.buf = self.buf[idx + 2..].to_string();
            for line in frame.lines() {
                if let Some(rest) = line.strip_prefix("data: ") {
                    out.push(rest.to_string());
                } else if let Some(rest) = line.strip_prefix("data:") {
                    out.push(rest.to_string());
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_single_complete_frame() {
        let mut p = SseParser::new();
        assert_eq!(p.push("data: {\"a\":1}\n\n"), vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn waits_for_the_blank_line_across_chunks() {
        let mut p = SseParser::new();
        assert_eq!(p.push("data: {\"a\":1}"), Vec::<String>::new());
        assert_eq!(p.push("\n\n"), vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn parses_multiple_frames_in_one_chunk() {
        let mut p = SseParser::new();
        assert_eq!(
            p.push("data: 1\n\ndata: 2\n\n"),
            vec!["1".to_string(), "2".to_string()]
        );
    }

    #[test]
    fn ignores_non_data_lines() {
        let mut p = SseParser::new();
        assert_eq!(p.push(": comment\n\n"), Vec::<String>::new());
    }
}
```

- [ ] **Step 5: Register the module and run the tests**

Add `mod sse;` near the top of `client/src-tauri/src/lib.rs`.
Run: `cd client/src-tauri && cargo test sse`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add client/package.json client/package-lock.json client/src-tauri
git commit -m "feat(client): scaffold Tauri v2 shell and Rust SSE parser"
```

---

### Task 4: Rust config module + commands

**Files:**
- Create: `client/src-tauri/src/config.rs`
- Modify: `client/src-tauri/src/lib.rs` (module + command registration)
- Test: Rust unit tests inside `config.rs`

**Interfaces:**
- Consumes: nothing from earlier Rust tasks (independent module).
- Produces:
  - `#[derive(Serialize, Deserialize, Clone, Default)] pub struct AppConfig { pub agent_base: String, pub dashboard_base: String }`
  - `pub fn read_config(path: &std::path::Path) -> AppConfig` (missing/invalid file → default) and `pub fn write_config(path: &std::path::Path, cfg: &AppConfig) -> std::io::Result<()>` — pure file helpers, unit-tested with a temp path.
  - Commands `get_config`, `set_config(config: AppConfig)`, `check_health(base: String) -> bool` registered in `lib.rs`.

- [ ] **Step 1: Write `config.rs` with failing tests** — create `client/src-tauri/src/config.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::path::Path;

// rename_all = "camelCase" so the JSON the frontend sees over IPC and on disk is
// { "agentBase", "dashboardBase" } — matching the TS `AppConfig` interface.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub agent_base: String,
    #[serde(default)]
    pub dashboard_base: String,
}

pub fn read_config(path: &Path) -> AppConfig {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

pub fn write_config(path: &Path, cfg: &AppConfig) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(cfg).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_yields_default() {
        let dir = std::env::temp_dir().join(format!("rhumb-cfg-{}", std::process::id()));
        let path = dir.join("does-not-exist.json");
        assert_eq!(read_config(&path), AppConfig::default());
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = std::env::temp_dir().join(format!("rhumb-cfg-rt-{}", std::process::id()));
        let path = dir.join("config.json");
        let cfg = AppConfig {
            agent_base: "http://host-a:8787".into(),
            dashboard_base: "http://host-d:8788".into(),
        };
        write_config(&path, &cfg).unwrap();
        assert_eq!(read_config(&path), cfg);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 2: Run the config tests**

Run: `cd client/src-tauri && cargo test config`
Expected: 2 tests PASS (after Step 3 registers the module). If `cargo test` reports `config` is not found, complete Step 3 first, then re-run.

- [ ] **Step 3: Wire the module + commands** in `client/src-tauri/src/lib.rs`. Add `mod config;` and add these command functions and registration. Use the app config dir for the file path:

```rust
use tauri::Manager;

fn config_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .expect("app config dir")
        .join("config.json")
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> config::AppConfig {
    config::read_config(&config_path(&app))
}

#[tauri::command]
fn set_config(app: tauri::AppHandle, config: config::AppConfig) -> Result<(), String> {
    config::write_config(&config_path(&app), &config).map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_health(base: String) -> bool {
    let url = format!("{}/healthz", base.trim_end_matches('/'));
    match reqwest::get(&url).await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}
```

Add `reqwest = { version = "0.12", features = ["json"] }` and `serde_json = "1"` and `serde = { version = "1", features = ["derive"] }` to `client/src-tauri/Cargo.toml` `[dependencies]` (serde may already be present from the scaffold — don't duplicate). Register the three commands in the existing `tauri::generate_handler![...]` call.

- [ ] **Step 4: Build + run the config tests**

Run: `cd client/src-tauri && cargo build && cargo test config`
Expected: builds; 2 config tests PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri/src/config.rs client/src-tauri/src/lib.rs client/src-tauri/Cargo.toml client/src-tauri/Cargo.lock
git commit -m "feat(client): Rust config module and get/set/health commands"
```

---

### Task 5: Rust agent + registry proxy commands (Channel streaming)

**Files:**
- Create: `client/src-tauri/src/proxy.rs`
- Modify: `client/src-tauri/src/lib.rs` (module + command registration + cancellation state)

**Interfaces:**
- Consumes: `SseParser` (Task 3).
- Produces commands: `send_message(agent_base, turn_id, prompt, session_id: Option<String>)`; `start_agent_stream(agent_base, turn_id, on_event: Channel<serde_json::Value>)`; `stop_agent_stream(turn_id)`; `get_registry(dashboard_base) -> serde_json::Value`; `start_registry_stream(dashboard_base, on_update: Channel<serde_json::Value>)`; `stop_registry_stream()`.

This task is glue (network + Channels); it is **build-verified** (`cargo build`), not unit-tested — the SSE parsing it relies on is already tested in Task 3, and the live behavior is verified in the driven run.

- [ ] **Step 1: Create `client/src-tauri/src/proxy.rs`**

```rust
use crate::sse::SseParser;
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct StreamState {
    pub agent: Mutex<HashMap<String, CancellationToken>>,
    pub registry: Mutex<Option<CancellationToken>>,
}

async fn pump(url: String, on_event: Channel<Value>, token: CancellationToken) {
    let resp = match reqwest::get(&url).await {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut stream = resp.bytes_stream();
    let mut parser = SseParser::new();
    loop {
        tokio::select! {
            _ = token.cancelled() => break,
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            for payload in parser.push(text) {
                                if let Ok(v) = serde_json::from_str::<Value>(&payload) {
                                    let _ = on_event.send(v);
                                }
                            }
                        }
                    }
                    _ => break,
                }
            }
        }
    }
}

#[tauri::command]
pub async fn send_message(
    agent_base: String,
    turn_id: String,
    prompt: String,
    session_id: Option<String>,
) -> Result<(), String> {
    let url = format!("{}/messages", agent_base.trim_end_matches('/'));
    let mut body = serde_json::json!({ "turnId": turn_id, "prompt": prompt });
    if let Some(sid) = session_id {
        body["sessionId"] = Value::String(sid);
    }
    reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_agent_stream(
    state: tauri::State<'_, StreamState>,
    agent_base: String,
    turn_id: String,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let token = CancellationToken::new();
    state.agent.lock().unwrap().insert(turn_id.clone(), token.clone());
    let url = format!("{}/turns/{}/stream", agent_base.trim_end_matches('/'), turn_id);
    tokio::spawn(async move { pump(url, on_event, token).await });
    Ok(())
}

#[tauri::command]
pub fn stop_agent_stream(state: tauri::State<'_, StreamState>, turn_id: String) {
    if let Some(tok) = state.agent.lock().unwrap().remove(&turn_id) {
        tok.cancel();
    }
}

#[tauri::command]
pub async fn get_registry(dashboard_base: String) -> Result<Value, String> {
    let url = format!("{}/registry", dashboard_base.trim_end_matches('/'));
    reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_registry_stream(
    state: tauri::State<'_, StreamState>,
    dashboard_base: String,
    on_update: Channel<Value>,
) -> Result<(), String> {
    let token = CancellationToken::new();
    *state.registry.lock().unwrap() = Some(token.clone());
    let url = format!("{}/registry/stream", dashboard_base.trim_end_matches('/'));
    tokio::spawn(async move { pump(url, on_update, token).await });
    Ok(())
}

#[tauri::command]
pub fn stop_registry_stream(state: tauri::State<'_, StreamState>) {
    if let Some(tok) = state.registry.lock().unwrap().take() {
        tok.cancel();
    }
}
```

- [ ] **Step 2: Wire the module, state, deps, and commands** in `client/src-tauri/src/lib.rs`:
  - Add `mod proxy;`.
  - In the builder, add `.manage(proxy::StreamState::default())` before `.invoke_handler(...)`.
  - Add the six proxy commands to `generate_handler![...]` (alongside `get_config`, `set_config`, `check_health`).
  - Add to `client/src-tauri/Cargo.toml` `[dependencies]`: `tokio = { version = "1", features = ["full"] }`, `tokio-util = "0.7"`, `futures-util = "0.3"`. (`reqwest`/`serde_json` are already present from Task 4.)

- [ ] **Step 3: Build**

Run: `cd client/src-tauri && cargo build`
Expected: compiles; exit 0. Fix any compiler errors the build reports (e.g. a missing feature flag) until clean.

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/proxy.rs client/src-tauri/src/lib.rs client/src-tauri/Cargo.toml client/src-tauri/Cargo.lock
git commit -m "feat(client): Rust agent/registry proxy commands with Channel streaming"
```

---

### Task 6: Frontend IPC layer + jsdom test setup + ConnectionScreen

**Files:**
- Modify: `client/vite.config.ts` (jsdom env), `client/package.json` (testing-library deps), `client/tsconfig.json` (DOM types already present)
- Create: `client/src/lib/tauri.ts`, `client/src/components/ConnectionScreen.tsx`
- Test: `client/test/ConnectionScreen.test.tsx`

**Interfaces:**
- Produces (`lib/tauri.ts`): typed wrappers — `getConfig(): Promise<AppConfig>`, `setConfig(c: AppConfig): Promise<void>`, `checkHealth(base: string): Promise<boolean>`, `sendMessage(agentBase, turnId, prompt, sessionId?)`, `openAgentStream(agentBase, turnId, onEvent: (e: AgentEvent) => void): () => void` (returns a stop fn), `getRegistry(dashboardBase): Promise<RegistrySnapshot>`, `openRegistryStream(dashboardBase, onUpdate: (s: RegistrySnapshot) => void): () => void`, and `interface AppConfig { agentBase: string; dashboardBase: string }`.
- Produces (`ConnectionScreen.tsx`): `<ConnectionScreen onConnected={(c: AppConfig) => void} />`.

- [ ] **Step 1: Add test deps + switch the component test env to jsdom**

In `client/package.json` `devDependencies` add: `"@testing-library/react": "^16.0.0"`, `"@testing-library/jest-dom": "^6.4.0"`, `"@testing-library/user-event": "^14.5.0"`, `"jsdom": "^24.0.0"`.

Run: `cd client && npm install`
Expected: exit 0.

Update `client/vite.config.ts` so DOM tests use jsdom while keeping node-pure tests working (jsdom is a superset for our purposes — switch the single env to jsdom):

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    globals: true,
  },
});
```

- [ ] **Step 2: Create `client/src/lib/tauri.ts`**

```typescript
import { invoke, Channel } from "@tauri-apps/api/core";
import type { AgentEvent, RegistrySnapshot } from "./types";

export interface AppConfig {
  agentBase: string;
  dashboardBase: string;
}

export function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

export function setConfig(config: AppConfig): Promise<void> {
  return invoke("set_config", { config });
}

export function checkHealth(base: string): Promise<boolean> {
  return invoke<boolean>("check_health", { base });
}

export function sendMessage(
  agentBase: string,
  turnId: string,
  prompt: string,
  sessionId?: string,
): Promise<void> {
  return invoke("send_message", { agentBase, turnId, prompt, sessionId: sessionId ?? null });
}

export function openAgentStream(
  agentBase: string,
  turnId: string,
  onEvent: (e: AgentEvent) => void,
): () => void {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  void invoke("start_agent_stream", { agentBase, turnId, onEvent: channel });
  return () => void invoke("stop_agent_stream", { turnId });
}

export function getRegistry(dashboardBase: string): Promise<RegistrySnapshot> {
  return invoke<RegistrySnapshot>("get_registry", { dashboardBase });
}

export function openRegistryStream(
  dashboardBase: string,
  onUpdate: (s: RegistrySnapshot) => void,
): () => void {
  const channel = new Channel<RegistrySnapshot>();
  channel.onmessage = onUpdate;
  void invoke("start_registry_stream", { dashboardBase, onUpdate: channel });
  return () => void invoke("stop_registry_stream");
}
```

- [ ] **Step 3: Write the failing ConnectionScreen test** — `client/test/ConnectionScreen.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionScreen } from "../src/components/ConnectionScreen";

vi.mock("../src/lib/tauri", () => ({
  getConfig: vi.fn().mockResolvedValue({ agentBase: "", dashboardBase: "" }),
  setConfig: vi.fn().mockResolvedValue(undefined),
  checkHealth: vi.fn().mockResolvedValue(true),
}));

import { checkHealth, setConfig } from "../src/lib/tauri";

describe("ConnectionScreen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls onConnected after both hosts pass health checks", async () => {
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await userEvent.type(screen.getByLabelText(/agent host/i), "http://a:8787");
    await userEvent.type(screen.getByLabelText(/dashboard host/i), "http://d:8788");
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));

    expect(checkHealth).toHaveBeenCalledWith("http://a:8787");
    expect(checkHealth).toHaveBeenCalledWith("http://d:8788");
    expect(setConfig).toHaveBeenCalledWith({ agentBase: "http://a:8787", dashboardBase: "http://d:8788" });
    expect(onConnected).toHaveBeenCalledWith({ agentBase: "http://a:8787", dashboardBase: "http://d:8788" });
  });

  it("shows an error and does not connect when a host fails", async () => {
    (checkHealth as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const onConnected = vi.fn();
    render(<ConnectionScreen onConnected={onConnected} />);

    await userEvent.type(screen.getByLabelText(/agent host/i), "http://a:8787");
    await userEvent.type(screen.getByLabelText(/dashboard host/i), "http://d:8788");
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));

    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByText(/could not reach/i)).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd client && npx vitest run test/ConnectionScreen.test.tsx`
Expected: FAIL — cannot resolve `../src/components/ConnectionScreen`.

- [ ] **Step 5: Implement `client/src/components/ConnectionScreen.tsx`**

```tsx
import { useState } from "react";
import { checkHealth, setConfig, type AppConfig } from "../lib/tauri";

export function ConnectionScreen({ onConnected }: { onConnected: (c: AppConfig) => void }) {
  const [agentBase, setAgentBase] = useState("");
  const [dashboardBase, setDashboardBase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    setError(null);
    const [agentOk, dashOk] = await Promise.all([checkHealth(agentBase), checkHealth(dashboardBase)]);
    if (!agentOk || !dashOk) {
      setError(`Could not reach ${!agentOk ? "the agent host" : "the dashboard host"}.`);
      setBusy(false);
      return;
    }
    const cfg: AppConfig = { agentBase, dashboardBase };
    await setConfig(cfg);
    setBusy(false);
    onConnected(cfg);
  }

  return (
    <div>
      <h1>Connect Rhumb</h1>
      <label htmlFor="agent">Agent host</label>
      <input id="agent" value={agentBase} onChange={(e) => setAgentBase(e.target.value)} />
      <label htmlFor="dash">Dashboard host</label>
      <input id="dash" value={dashboardBase} onChange={(e) => setDashboardBase(e.target.value)} />
      <button onClick={connect} disabled={busy}>Connect</button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd client && npx vitest run test/ConnectionScreen.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add client/package.json client/package-lock.json client/vite.config.ts client/src/lib/tauri.ts client/src/components/ConnectionScreen.tsx client/test/ConnectionScreen.test.tsx
git commit -m "feat(client): IPC layer, jsdom test setup, and ConnectionScreen"
```

---

### Task 7: AgentPanel

**Files:**
- Create: `client/src/components/AgentPanel.tsx`
- Test: `client/test/AgentPanel.test.tsx`

**Interfaces:**
- Consumes: `reduceAgent`/`initialAgentState` (agentEvents), `addSession` (session), `openAgentStream`/`sendMessage` (lib/tauri).
- Produces: `<AgentPanel agentBase={string} />` — input + transcript; submitting opens an agent stream for a new `turnId` then sends the message; renders messages from the reducer.

- [ ] **Step 1: Write the failing test** — `client/test/AgentPanel.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentEvent } from "../src/lib/types";
import { AgentPanel } from "../src/components/AgentPanel";

let capturedOnEvent: ((e: AgentEvent) => void) | null = null;

vi.mock("../src/lib/tauri", () => ({
  openAgentStream: vi.fn((_base: string, _turnId: string, onEvent: (e: AgentEvent) => void) => {
    capturedOnEvent = onEvent;
    return () => {};
  }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

import { openAgentStream, sendMessage } from "../src/lib/tauri";

describe("AgentPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnEvent = null;
  });

  it("opens a stream then sends the message on submit, and renders streamed events", async () => {
    render(<AgentPanel agentBase="http://a:8787" />);

    await userEvent.type(screen.getByRole("textbox"), "hello");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    // stream opened before send
    expect(openAgentStream).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const streamOrder = (openAgentStream as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const sendOrder = (sendMessage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(streamOrder).toBeLessThan(sendOrder);

    // a streamed result event renders
    capturedOnEvent?.({ type: "result", result: "the answer", isError: false });
    expect(await screen.findByText("the answer")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run test/AgentPanel.test.tsx`
Expected: FAIL — cannot resolve `../src/components/AgentPanel`.

- [ ] **Step 3: Implement `client/src/components/AgentPanel.tsx`**

```tsx
import { useState } from "react";
import { reduceAgent, initialAgentState, type AgentState } from "../lib/agentEvents";
import { openAgentStream, sendMessage } from "../lib/tauri";

export function AgentPanel({ agentBase }: { agentBase: string }) {
  const [state, setState] = useState<AgentState>(initialAgentState);
  const [draft, setDraft] = useState("");

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const turnId = crypto.randomUUID();
    // Open the stream first (stream-first), then send.
    openAgentStream(agentBase, turnId, (event) => {
      setState((prev) => reduceAgent(prev, event));
    });
    await sendMessage(agentBase, turnId, text, state.sessionId ?? undefined);
  }

  return (
    <div>
      <ul>
        {state.messages.map((m, i) => (
          <li key={i} data-kind={m.kind}>
            {m.kind === "tool" ? `🔧 ${m.toolName}` : m.text}
          </li>
        ))}
      </ul>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={submit}>Send</button>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run test/AgentPanel.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/AgentPanel.tsx client/test/AgentPanel.test.tsx
git commit -m "feat(client): AgentPanel with stream-first turn submission"
```

---

### Task 8: Canvas with detachable surfaces

**Files:**
- Create: `client/src/components/Canvas.tsx`
- Test: `client/test/Canvas.test.tsx`

**Interfaces:**
- Consumes: `reduceRegistry`/`Tab` (registryStore), `openRegistryStream` (lib/tauri), `WebviewWindow` (`@tauri-apps/api/webviewWindow`).
- Produces: `<Canvas dashboardBase={string} />` — tab strip from the registry stream; active surface in a sandboxed iframe; a Detach button creating a `WebviewWindow`.

- [ ] **Step 1: Write the failing test** — `client/test/Canvas.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RegistrySnapshot } from "../src/lib/types";
import { Canvas } from "../src/components/Canvas";

let capturedOnUpdate: ((s: RegistrySnapshot) => void) | null = null;
const ctor = vi.fn();

vi.mock("../src/lib/tauri", () => ({
  openRegistryStream: vi.fn((_base: string, onUpdate: (s: RegistrySnapshot) => void) => {
    capturedOnUpdate = onUpdate;
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    constructor(label: string, opts: { url: string }) {
      ctor(label, opts);
    }
  },
}));

describe("Canvas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnUpdate = null;
  });

  it("renders tabs from the registry stream and the active surface in an iframe", async () => {
    render(<Canvas dashboardBase="http://d:8788" />);
    capturedOnUpdate?.({
      surfaces: [{ id: "demo", title: "Demo", url: "/surfaces/demo/", kind: "file", created: "t", updated: "t" }],
    });
    expect(await screen.findByRole("button", { name: "Demo" })).toBeTruthy();
    const iframe = document.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe("http://d:8788/surfaces/demo/");
    expect(iframe?.getAttribute("sandbox")).toContain("allow-scripts");
  });

  it("detaches the active surface into a WebviewWindow", async () => {
    render(<Canvas dashboardBase="http://d:8788" />);
    capturedOnUpdate?.({
      surfaces: [{ id: "demo", title: "Demo", url: "/surfaces/demo/", kind: "file", created: "t", updated: "t" }],
    });
    await screen.findByRole("button", { name: "Demo" });
    await userEvent.click(screen.getByRole("button", { name: /detach/i }));
    expect(ctor).toHaveBeenCalledWith("surface:demo", expect.objectContaining({ url: "http://d:8788/surfaces/demo/" }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run test/Canvas.test.tsx`
Expected: FAIL — cannot resolve `../src/components/Canvas`.

- [ ] **Step 3: Implement `client/src/components/Canvas.tsx`**

```tsx
import { useEffect, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { reduceRegistry, type Tab } from "../lib/registryStore";
import { openRegistryStream } from "../lib/tauri";

export function Canvas({ dashboardBase }: { dashboardBase: string }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const stop = openRegistryStream(dashboardBase, (snap) => {
      const next = reduceRegistry(snap);
      setTabs(next);
      setActiveId((cur) => cur ?? next[0]?.id ?? null);
    });
    return stop;
  }, [dashboardBase]);

  const active = tabs.find((t) => t.id === activeId) ?? null;
  const activeUrl = active ? `${dashboardBase}${active.url}` : null;

  function detach() {
    if (!active || !activeUrl) return;
    new WebviewWindow(`surface:${active.id}`, { url: activeUrl, title: active.title });
  }

  return (
    <div>
      <div role="tablist">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setActiveId(t.id)}>{t.title}</button>
        ))}
        {active && <button onClick={detach}>Detach</button>}
      </div>
      {activeUrl && (
        <iframe title={active!.title} src={activeUrl} sandbox="allow-scripts allow-same-origin" />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run test/Canvas.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Canvas.tsx client/test/Canvas.test.tsx
git commit -m "feat(client): Canvas with registry tabs and detach-to-window"
```

---

### Task 9: Workspace + App wiring + capabilities/CSP + build gate

**Files:**
- Create: `client/src/components/Workspace.tsx`
- Modify: `client/src/App.tsx` (new), `client/src/main.tsx` (render App)
- Modify: `client/src-tauri/tauri.conf.json` (CSP), `client/src-tauri/capabilities/default.json` (scope to `main`)

**Interfaces:**
- Consumes: `ConnectionScreen`, `AgentPanel`, `Canvas`, `getConfig` (lib/tauri).
- Produces: `<Workspace agentBase dashboardBase />` (agent-left / canvas-right) and `<App />` (connection gating → Workspace).

- [ ] **Step 1: Write the failing test** — `client/test/App.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";

vi.mock("../src/lib/tauri", () => ({
  getConfig: vi.fn().mockResolvedValue({ agentBase: "", dashboardBase: "" }),
  checkHealth: vi.fn(),
  setConfig: vi.fn(),
  openAgentStream: vi.fn(() => () => {}),
  sendMessage: vi.fn(),
  openRegistryStream: vi.fn(() => () => {}),
}));

describe("App", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the connection screen when no config is set", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: /connect/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run test/App.test.tsx`
Expected: FAIL — cannot resolve `../src/App`.

- [ ] **Step 3: Create `client/src/components/Workspace.tsx`**

```tsx
import { AgentPanel } from "./AgentPanel";
import { Canvas } from "./Canvas";

export function Workspace({ agentBase, dashboardBase }: { agentBase: string; dashboardBase: string }) {
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div style={{ flex: "0 0 40%", overflow: "auto", resize: "horizontal" }}>
        <AgentPanel agentBase={agentBase} />
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <Canvas dashboardBase={dashboardBase} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `client/src/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { ConnectionScreen } from "./components/ConnectionScreen";
import { Workspace } from "./components/Workspace";
import { getConfig, type AppConfig } from "./lib/tauri";

export function App() {
  const [config, setConfigState] = useState<AppConfig | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getConfig().then((c) => {
      if (c.agentBase && c.dashboardBase) setConfigState(c);
      setLoaded(true);
    });
  }, []);

  if (!loaded) return <div>Loading…</div>;
  if (!config) return <ConnectionScreen onConnected={setConfigState} />;
  return <Workspace agentBase={config.agentBase} dashboardBase={config.dashboardBase} />;
}
```

- [ ] **Step 5: Update `client/src/main.tsx`**

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(<App />);
}
```

- [ ] **Step 6: Run the App test + full client suite**

Run: `cd client && npx vitest run`
Expected: all PASS (App + the component tests + the 3a foundation tests).

- [ ] **Step 7: Set CSP + scope the capability**

In `client/src-tauri/tauri.conf.json`, set the security CSP under `app.security.csp` to allow framing the runtime tailnet origins and IPC for the shell:

```json
"csp": "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost; frame-src http: https:; img-src 'self' data: http: https:; style-src 'self' 'unsafe-inline'; script-src 'self'"
```

In `client/src-tauri/capabilities/default.json`, ensure `"windows": ["main"]` (only the main window) and that it lists the permissions the shell uses (the `core:event:default` / `core:webview:*` set the CLI generated plus `core:default`). Do NOT add a capability for any `surface:*` label — those windows must remain permission-less.

- [ ] **Step 8: Build gate**

Run: `cd client && npx tsc -p tsconfig.json --noEmit && cd src-tauri && cargo build`
Expected: `tsc` clean; `cargo build` compiles. (A full `npx tauri build` is the heavier release gate; `cargo build` + `tsc` is sufficient for this task's CI.)

- [ ] **Step 9: Commit**

```bash
git add client/src/App.tsx client/src/main.tsx client/src/components/Workspace.tsx client/test/App.test.tsx client/src-tauri/tauri.conf.json client/src-tauri/capabilities/default.json
git commit -m "feat(client): Workspace, App gating, and capability/CSP hardening"
```

---

## Done criteria (automated)

- `cd agent-host && npx vitest run && npx tsc -p tsconfig.json --noEmit` — pass (reaping fix in).
- `cd client && npx vitest run && npx tsc -p tsconfig.json --noEmit` — pass (reducer fix + all component tests).
- `cd client/src-tauri && cargo test && cargo build` — pass (sse + config tests; whole shell compiles).

## Live verification (driver-run, after the automated gate)

Driven via computer-use on the dev Mac — **local-first**:
1. Run `agent-host` and `dashboard-host` on `localhost` (the agent host needs a real `CLAUDE_CODE_OAUTH_TOKEN`; the dashboard host needs a `<workspace>/surfaces/demo/` test surface).
2. `cd client && npm run tauri:dev`; in the connection screen enter the two localhost bases; verify both healthcheck.
3. Send a message in the agent panel → screenshot the streamed transcript. Confirm the demo surface tab renders in the iframe; click Detach → confirm a native window opens with the surface; screenshot.
4. Repoint config at the Proxmox deployment over Tailscale and repeat the surface/agent checks.

## Next plan

**Plan 4 — Data endpoint:** declared sources, read then read-write with confirmations + audit, so surfaces show live data and can write back. Surfaces gain a sanctioned data API; the canvas already renders them.
