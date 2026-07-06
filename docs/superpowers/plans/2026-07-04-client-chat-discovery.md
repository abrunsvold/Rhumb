# Client Batch (F8/F9/F14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat turn stream unable to wedge the operator loop (F8), the transcript auto-follow with a discoverable jump control (F9), and tailnet autodiscovery explain its failures with an IP fallback (F14) — per `docs/superpowers/specs/2026-07-04-client-chat-discovery-design.md`.

**Architecture:** Six tasks across three subsystems. Agent-host (TS) gains SSE heartbeats. The Tauri Rust proxy gains a turn-stream close sentinel + a pump idle timeout. The React hook decouples turn-completion accounting from the turn stream. The Transcript component gets robust stick-to-bottom + a jump affordance. The Rust discovery command returns a diagnostic report with IP fallback, and ConnectionScreen renders it.

**Tech Stack:** agent-host — TypeScript ESM, vitest. client front-end — React/TS, vitest + jsdom. client Rust — Tauri, `cargo test`.

## Global Constraints

- Heartbeat is an SSE comment line exactly `":keepalive\n\n"` (the Rust `SseParser` emits only `data:` lines, so comment frames never reach the reducer); interval ~15000 ms; cleared on request close.
- Pump idle timeout ~40000 ms (tolerant of one missed 15 s heartbeat + jitter); on timeout the pump loop ends so the caller's sentinel fires.
- Turn-stream close sentinel is exactly `{ "type": "stream_closed" }`, mirroring the session stream (`proxy.rs:387`).
- Turn accounting (`openTurns -1` + `turnStops`/`turnKey` cleanup) must be idempotent by `turnId` and must fire on a terminal `result`/`error` arriving on EITHER the turn stream OR the promoted tab's session stream, whichever first; and on a turn `stream_closed` with no terminal event yet.
- Discovery report shape: `{ hosts: DiscoveredHost[], scanned: number, attempts: ProbeAttempt[] }`; `ProbeAttempt = { peer: string, target: string, outcome: "matched" | "unreachable" | "not-rhumb" | "bad-response" }`. `DiscoveredHost` unchanged (`{ baseUrl, version }`).
- Manual Server URL entry on ConnectionScreen stays exactly as-is (the reliable path).
- Commit messages end with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. Run the focused test while iterating; the relevant full suite (`agent-host: npm test`; `client: npm test`; `client/src-tauri: cargo test`) plus the relevant build (`npm run build` / `cargo build`) before each commit.

## File Structure

- `agent-host/src/sse.ts` — add `heartbeatFrame()` + `attachHeartbeat(res, req, ms, timers?)` beside `writeSseEvent`.
- `agent-host/src/server.ts:103-116` — wire `attachHeartbeat` into both stream routes.
- `client/src-tauri/src/proxy.rs` — `pump` gains an idle timeout; `start_agent_stream` sends the close sentinel.
- `client/src/hooks/useChatSessions.ts` — turn accounting decoupled + leak reap.
- `client/src/components/Transcript.tsx` — stick-to-bottom rework + jump pill + stable keys.
- `client/src-tauri/src/discover.rs` — report struct, `parse_status_candidates`, outcome-recording `probe`, `discover_hosts` returns the report.
- `client/src/lib/tauri.ts` — `DiscoveryReport`/`ProbeAttempt` types + `discoverHosts` return type.
- `client/src/components/ConnectionScreen.tsx` — consume the report, render diagnostics on zero matches.

---

### Task 1: agent-host SSE heartbeat

**Files:**
- Modify: `agent-host/src/sse.ts`
- Modify: `agent-host/src/server.ts:103-116`
- Test: `agent-host/test/sse.test.ts`

**Interfaces:**
- Produces: `heartbeatFrame(): string` (returns `":keepalive\n\n"`); `attachHeartbeat(res: { write(s: string): void }, req: { on(ev: "close", cb: () => void): void }, ms?: number, timers?: { set: typeof setInterval; clear: typeof clearInterval }): () => void` — starts a heartbeat interval writing `heartbeatFrame()` every `ms` (default 15000), auto-clears on `req` close, and returns a manual clear fn.

- [ ] **Step 1: Write the failing tests** — append to `agent-host/test/sse.test.ts`:

```ts
import { heartbeatFrame, attachHeartbeat } from "../src/sse.js";

describe("heartbeat", () => {
  it("heartbeatFrame is an SSE comment line (ignored by data-only parsers)", () => {
    expect(heartbeatFrame()).toBe(":keepalive\n\n");
  });

  it("attachHeartbeat writes on the interval and stops on request close", () => {
    const writes: string[] = [];
    const res = { write: (s: string) => writes.push(s) };
    let closeCb: (() => void) | undefined;
    const req = { on: (_ev: "close", cb: () => void) => { closeCb = cb; } };
    let tick: (() => void) | undefined;
    const timers = {
      set: ((cb: () => void) => { tick = cb; return 1 as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval,
      clear: (() => { tick = undefined; }) as typeof clearInterval,
    };
    attachHeartbeat(res, req, 15000, timers);
    tick?.(); tick?.();
    expect(writes).toEqual([":keepalive\n\n", ":keepalive\n\n"]);
    closeCb?.();               // request closed → interval cleared
    expect(tick).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd agent-host && npx vitest run test/sse.test.ts` — FAIL (no such exports).

- [ ] **Step 3: Implement** — append to `agent-host/src/sse.ts`:

```ts
// SSE comment frame: keeps the socket alive during long silent turns without
// reaching the client reducer (comment lines carry no `data:` payload). Lets the
// client treat prolonged byte-silence as a genuinely dead connection.
export function heartbeatFrame(): string {
  return ":keepalive\n\n";
}

export function attachHeartbeat(
  res: { write(s: string): void },
  req: { on(ev: "close", cb: () => void): void },
  ms = 15000,
  timers: { set: typeof setInterval; clear: typeof clearInterval } = { set: setInterval, clear: clearInterval },
): () => void {
  const id = timers.set(() => res.write(heartbeatFrame()), ms);
  const clear = () => timers.clear(id);
  req.on("close", clear);
  return clear;
}
```

- [ ] **Step 4: Wire into both stream routes** — in `agent-host/src/server.ts`, add `attachHeartbeat` to the `./sse.js` import, then inside each stream route add the call after the subscriber is registered:

```ts
  app.get("/sessions/:id/stream", (req: Request, res: Response) => {
    res.set(SSE_HEADERS);
    res.flushHeaders?.();
    const id = req.params.id;
    subsFor(subscribers, id).add(res);
    attachHeartbeat(res, req);
    req.on("close", () => pruneSubscriber(subscribers, id, res));
  });

  app.get("/turns/:turnId/stream", (req: Request, res: Response) => {
    res.set(SSE_HEADERS);
    res.flushHeaders?.();
    const turnId = req.params.turnId;
    subsFor(turnSubscribers, turnId).add(res);
    attachHeartbeat(res, req);
    req.on("close", () => pruneSubscriber(turnSubscribers, turnId, res));
  });
```

- [ ] **Step 5: Run + full suite + commit**

```bash
cd agent-host && npx vitest run test/sse.test.ts && npm test && npm run build
git add agent-host/src/sse.ts agent-host/src/server.ts agent-host/test/sse.test.ts
git commit -m "feat(agent-host): SSE keepalive heartbeat on turn and session streams

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Rust turn-stream close sentinel + pump idle timeout

**Files:**
- Modify: `client/src-tauri/src/proxy.rs` (`pump` ~168-196, `start_agent_stream` ~221-235)
- Test: `client/src-tauri/src/proxy.rs` (`#[cfg(test)]` — a constant assertion; the network pump itself is not unit-testable)

**Interfaces:**
- Consumes: Task 1's heartbeat keeps healthy streams under the timeout.
- Produces: turn stream emits `{type:"stream_closed"}` on close (consumed by Task 3); named constant `PUMP_IDLE_TIMEOUT` for the idle bound.

- [ ] **Step 1: Add the idle timeout to `pump`.** Replace the `chunk = stream.next()` arm so a stall ends the loop. Add near the top of the file (with the other `use`s) `use std::time::Duration;` if not already present, and above `pump`:

```rust
// A healthy stream sends a heartbeat every ~15s (agent-host SSE keepalive), so
// >40s of total byte-silence means the socket is wedged, not merely quiet.
const PUMP_IDLE_TIMEOUT: Duration = Duration::from_secs(40);
```

New `pump` loop body:

```rust
    loop {
        tokio::select! {
            _ = token.cancelled() => break,
            chunk = tokio::time::timeout(PUMP_IDLE_TIMEOUT, stream.next()) => {
                match chunk {
                    Ok(Some(Ok(bytes))) => {
                        let text = decoder.push(&bytes);
                        for payload in parser.push(&text) {
                            if let Ok(v) = serde_json::from_str::<Value>(&payload) {
                                let _ = on_event.send(v);
                            }
                        }
                    }
                    _ => break,   // Ok(None)/Ok(Err) = stream end/error; Err(_) = idle timeout
                }
            }
        }
    }
```

- [ ] **Step 2: Send the close sentinel from the turn stream.** Change `start_agent_stream`'s spawn to mirror `start_session_stream` (proxy.rs:382-389):

```rust
    tokio::spawn(async move {
        pump(url, bearer, on_event.clone(), token.clone()).await;
        // The turn stream ended (result/error already forwarded, network drop, or
        // idle timeout). Tell the webview so it can close out turn accounting even
        // if the terminal event never arrived on this channel.
        if !token.is_cancelled() {
            let _ = on_event.send(serde_json::json!({ "type": "stream_closed" }));
        }
    });
```

- [ ] **Step 3: Add the constant assertion test** (the pump's network behavior is integration-only; assert the bound is the intended value so a later edit can't silently tighten it below the heartbeat tolerance). In the `#[cfg(test)] mod tests` of proxy.rs (add the module if none exists):

```rust
    #[test]
    fn pump_idle_timeout_tolerates_a_missed_heartbeat() {
        // heartbeat ~15s; timeout must exceed 2 intervals so one dropped beat
        // plus jitter doesn't kill a healthy long-running turn.
        assert!(PUMP_IDLE_TIMEOUT.as_secs() >= 30);
    }
```

- [ ] **Step 4: Build + test + commit**

```bash
cd client/src-tauri && cargo test && cargo build
git add src/proxy.rs
git commit -m "fix(client): turn-stream close sentinel + pump idle timeout so a wedged socket can't hang a turn

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: hook turn-accounting decouple + leak reap (F8 core)

**Files:**
- Modify: `client/src/hooks/useChatSessions.ts`
- Test: `client/test/useChatSessions.test.tsx`

**Interfaces:**
- Consumes: Task 2's turn `stream_closed`; the session stream's terminal `result`/`error` (existing).
- Produces: no exported API change; `send()` behavior hardened.

**Design:** extract a single idempotent `finishTurn(turnId)` that stops the turn stream, decrements `openTurns` on the turn's current key, and deletes the `turnStops`/`turnKey` entries — guarded by `turnStops.current.has(turnId)` so it runs at most once. Call it from three places: (a) terminal event on the turn stream; (b) turn `stream_closed` on the turn stream; (c) terminal event observed on the session stream for a turn still open. For (c), the hook must know which open `turnId` maps to a session key — it already has `turnKey` (turnId → key); add the reverse lookup inline.

- [ ] **Step 1: Write the failing tests** — add to `client/test/useChatSessions.test.tsx` (match the file's existing harness: it renders the hook and drives fake `openAgentStream`/`openSessionStream` callbacks; reuse those fakes):

```tsx
it("clears busy when the terminal result arrives on the SESSION stream, not the turn stream", async () => {
  // Drive: send from a draft → promote (session event) → the turn stream goes
  // silent, but the session stream delivers the result.
  // Expect: busy (openTurns) returns to 0 for the tab.
  // (Wire via the file's existing fake stream harness: capture the turn-stream
  // and session-stream callbacks, emit `session` then, on the SESSION callback,
  // emit `{type:"result"}`, and assert the tab's busy is false.)
});

it("clears busy when the turn stream closes with no terminal event", async () => {
  // Emit only `{type:"stream_closed"}` on the turn stream after send; assert busy false.
});

it("does not double-decrement if result arrives on both streams", async () => {
  // Emit result on the turn stream AND the session stream; assert openTurns never goes negative.
});
```

(Reproduce the file's fake-stream plumbing exactly — read the top of `useChatSessions.test.tsx` for the existing `openAgentStream`/`openSessionStream` mock shape and the store-inspection helper it uses; do not invent a new harness.)

- [ ] **Step 2: Run to verify failure** — `cd client && npx vitest run test/useChatSessions.test.tsx` — FAIL.

- [ ] **Step 3: Implement.** In `useChatSessions.ts`, add the idempotent helper inside `useChatSessions` (above `send`):

```ts
  // Close out a turn exactly once: stop its stream, drop its busy count, forget it.
  // Safe to call from the turn stream, its stream_closed, or the session stream.
  function finishTurn(turnId: string) {
    if (!turnStops.current.has(turnId)) return;
    turnStops.current.get(turnId)?.();
    turnStops.current.delete(turnId);
    const k = turnKey.current.get(turnId);
    if (k) setStore((s) => bumpTurns(s, k, -1));
    turnKey.current.delete(turnId);
  }
```

Replace the terminal-event block in the turn-stream handler (useChatSessions.ts:178-185) with:

```ts
      if (event.type === "result" || event.type === "error") finishTurn(turnId);
```

Handle the turn stream's `stream_closed` at the top of the turn-stream handler (before the routing logic):

```ts
    const stop = openAgentStream(agentBase, turnId, (event) => {
      if ((event as { type?: string }).type === "stream_closed") { finishTurn(turnId); return; }
      const k = turnKey.current.get(turnId) ?? key;
      ...
```

In `attachSessionStream`, close out any open turn bound to this session when a terminal event arrives on the session stream. Replace the non-`stream_closed` branch (useChatSessions.ts:77-78):

```ts
      retryCount.current.set(sessionId, 0);
      const ev = raw as AgentEvent;
      if (ev.type === "result" || ev.type === "error") {
        for (const [tid, k] of turnKey.current.entries()) if (k === sessionId) finishTurn(tid);
      }
      setStore((s) => reduceEvent(setStale(s, sessionId, false), sessionId, ev));
```

Update the `sendMessage` catch (useChatSessions.ts:194-198) to reuse the helper: replace its inline stop/delete/bump with `finishTurn(turnId);` (keep the `reduceEvent` error line and `return false`).

- [ ] **Step 4: Run to verify pass** — `cd client && npx vitest run test/useChatSessions.test.tsx` — PASS.

- [ ] **Step 5: Full suite + build + commit**

```bash
cd client && npm test && npm run build
git add src/hooks/useChatSessions.ts test/useChatSessions.test.tsx
git commit -m "fix(client): close out a turn from whichever stream delivers it; reap stalled turns (F8)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Transcript follow + jump affordance + stable keys (F9)

**Files:**
- Modify: `client/src/components/Transcript.tsx`
- Test: `client/test/Transcript.test.tsx`

**Interfaces:**
- Consumes: `TranscriptMessage[]` + `busy` (unchanged props).
- Produces: no prop change; adds a "Jump to latest" control internally.

**Design:** replace the raw-`scroll` latch with a user-intent latch. `stickToBottom` starts true. A `wheel`/`touchmove`/`keydown` handler on the container sets it based on current position (unlatch when the user moves away from the bottom). A `newSinceUnstick` state drives the jump pill. The auto-scroll effect scrolls only when `stickToBottom` is true; when false and messages grew, set `newSinceUnstick = true`.

- [ ] **Step 1: Write the failing tests** — add to `client/test/Transcript.test.tsx` (match its existing render + `data-testid="transcript"` query style; jsdom gives 0 heights, so drive `stickToBottom` via the exposed behavior — assert `scrollTop` assignment and pill presence, mocking `scrollHeight`/`clientHeight`/`scrollTop` on the container as the existing tests do if they do; otherwise set them via `Object.defineProperty`):

```tsx
it("auto-scrolls to bottom on a new message while stuck to bottom", () => {
  // render with 1 msg, capture container, set scrollHeight; rerender with 2 msgs;
  // expect container.scrollTop === container.scrollHeight.
});

it("shows a jump-to-latest pill and does NOT auto-scroll after the user scrolls up", () => {
  // simulate a wheel event that leaves the container far from bottom (set
  // scrollTop low, scrollHeight high); rerender with a new msg; expect no
  // scrollTop jump and a visible "Jump to latest" control.
});

it("clicking jump-to-latest scrolls to bottom and hides the pill", () => {
  // from the scrolled-up state, click the pill; expect scrollTop === scrollHeight
  // and the pill gone.
});

it("a programmatic scroll event does not unlatch stick-to-bottom", () => {
  // fire a raw 'scroll' event (not wheel/touch/keydown); rerender with a new msg;
  // expect it still auto-scrolls (latch survived).
});
```

- [ ] **Step 2: Run to verify failure** — `cd client && npx vitest run test/Transcript.test.tsx` — FAIL.

- [ ] **Step 3: Implement** — replace the `Transcript` function body (keep `ToolChip`/`Message` unchanged, but change the `Message` call site to a stable key):

```tsx
export function Transcript({ messages, busy }: { messages: TranscriptMessage[]; busy: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const prevLen = useRef(messages.length);

  function atBottom(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  // Only genuine user-initiated scrolling changes the follow decision — a raw
  // 'scroll' event also fires on reflow/programmatic scroll and must NOT unlatch.
  function onUserScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = atBottom(el);
    if (stickToBottom.current) setShowJump(false);
  }

  function jump() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
    setShowJump(false);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (messages.length > prevLen.current) {
      setShowJump(true);
    }
    prevLen.current = messages.length;
  }, [messages, busy]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        onKeyDown={onUserScroll}
        data-testid="transcript"
        className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2"
      >
        {messages.length === 0 && !busy && (
          <p className="m-auto text-muted">Send a message to start a session.</p>
        )}
        {messages.map((m, i) => (
          <Message key={m.id ?? i} m={m} />
        ))}
        {busy && (
          <div className="self-start text-muted text-xs animate-pulse">thinking…</div>
        )}
      </div>
      {showJump && (
        <button
          onClick={jump}
          data-testid="jump-latest"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line bg-raised px-3 py-1 text-xs text-ink shadow"
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  );
}
```

Add `useState` to the existing `react` import. **`TranscriptMessage.id`:** check `client/src/lib/agentEvents.ts` — if `TranscriptMessage` has no `id`, the `m.id ?? i` fallback keeps it compiling and behaves as today; if adding a stable id is cheap there (a per-message counter in the reducer), do it and drop the `?? i`. If not trivially available, keep `m.id ?? i` and leave a one-line note — do not reshape the reducer in this task.

- [ ] **Step 4: Run to verify pass** — `cd client && npx vitest run test/Transcript.test.tsx` — PASS.

- [ ] **Step 5: Full suite + build + commit**

```bash
cd client && npm test && npm run build
git add src/components/Transcript.tsx test/Transcript.test.tsx
git commit -m "fix(client): transcript follows the live edge and offers jump-to-latest (F9)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: discovery report + IP fallback (Rust)

**Files:**
- Modify: `client/src-tauri/src/discover.rs`
- Test: `client/src-tauri/src/discover.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `DiscoveryReport { hosts: Vec<DiscoveredHost>, scanned: usize, attempts: Vec<ProbeAttempt> }` and `ProbeAttempt { peer: String, target: String, outcome: String }` (serde camelCase); `discover_hosts` returns `DiscoveryReport`; `parse_status_candidates(json) -> Vec<Candidate>` where `Candidate { peer: String, origin: String }` (one per online peer per address — MagicDNS name and first Tailscale IP).

- [ ] **Step 1: Write the failing tests** — replace the `parses_online_peers_and_trims_trailing_dots` test and add:

```rust
    #[test]
    fn candidates_include_dns_name_and_tailscale_ip_per_online_peer() {
        let json = r#"{
          "Peer": {
            "k1": { "DNSName": "box.tail1.ts.net.", "Online": true, "TailscaleIPs": ["100.64.0.1", "fd7a::1"] },
            "k2": { "DNSName": "off.tail1.ts.net.", "Online": false, "TailscaleIPs": ["100.64.0.2"] },
            "k3": { "Online": true }
          }
        }"#;
        let c = parse_status_candidates(json);
        let origins: Vec<&str> = c.iter().map(|x| x.origin.as_str()).collect();
        assert!(origins.contains(&"https://box.tail1.ts.net"));
        assert!(origins.contains(&"https://100.64.0.1"));    // IP fallback
        assert!(!origins.iter().any(|o| o.contains("off.tail1")));  // offline skipped
        // every candidate is labeled with its peer name for the report
        assert!(c.iter().all(|x| !x.peer.is_empty()));
    }

    #[test]
    fn tolerates_malformed_or_peerless_status() {
        assert!(parse_status_candidates("not json").is_empty());
        assert!(parse_status_candidates("{}").is_empty());
    }

    #[test]
    fn report_classifies_manifest_outcomes() {
        // manifest_to_host still gates on rhumb:true (unchanged behavior)
        let m = |rhumb: bool| RhumbManifest { rhumb, version: "1.0".into(), paths: ManifestPaths { agent: "/agent".into(), dashboard: "/".into() } };
        assert!(manifest_to_host("https://a".into(), m(false)).is_none());
        assert_eq!(manifest_to_host("https://a".into(), m(true)), Some(DiscoveredHost { base_url: "https://a".into(), version: "1.0".into() }));
    }
```

- [ ] **Step 2: Run to verify failure** — `cd client/src-tauri && cargo test` — FAIL (no `parse_status_candidates` / `Candidate`).

- [ ] **Step 3: Implement.** Add the types and rewrite discovery:

```rust
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeAttempt {
    pub peer: String,
    pub target: String,
    pub outcome: String, // "matched" | "unreachable" | "not-rhumb" | "bad-response"
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryReport {
    pub hosts: Vec<DiscoveredHost>,
    pub scanned: usize,
    pub attempts: Vec<ProbeAttempt>,
}

#[derive(Clone, Debug)]
pub struct Candidate {
    pub peer: String,
    pub origin: String,
}

/// Per online peer: its MagicDNS-name origin AND its first Tailscale IP origin
/// (both https). The IP is a fallback for when serve's HTTPS name routing or the
/// client's netmap view of DNSName doesn't line up with what's actually served.
pub fn parse_status_candidates(json: &str) -> Vec<Candidate> {
    let v: Value = match serde_json::from_str(json) { Ok(v) => v, Err(_) => return Vec::new() };
    let Some(peers) = v.get("Peer").and_then(Value::as_object) else { return Vec::new() };
    let mut out = Vec::new();
    for p in peers.values() {
        if !p.get("Online").and_then(Value::as_bool).unwrap_or(false) { continue; }
        let name = p.get("DNSName").and_then(Value::as_str).map(|d| d.trim_end_matches('.').to_string());
        let peer = name.clone().unwrap_or_else(|| "(unnamed peer)".to_string());
        if let Some(n) = &name {
            out.push(Candidate { peer: peer.clone(), origin: format!("https://{}", n) });
        }
        if let Some(ip) = p.get("TailscaleIPs").and_then(Value::as_array)
            .and_then(|a| a.iter().find_map(Value::as_str))
        {
            out.push(Candidate { peer: peer.clone(), origin: format!("https://{}", ip) });
        }
    }
    out
}
```

Rewrite `probe` to classify, and `discover_hosts` to assemble the report:

```rust
async fn probe(client: &reqwest::Client, cand: Candidate) -> (Option<DiscoveredHost>, ProbeAttempt) {
    let url = format!("{}/.well-known/rhumb.json", cand.origin);
    let attempt = |outcome: &str| ProbeAttempt { peer: cand.peer.clone(), target: cand.origin.clone(), outcome: outcome.into() };
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return (None, attempt("unreachable")),
    };
    // Route through manifest_to_host so the rhumb:true gate lives in one place.
    match resp.json::<RhumbManifest>().await {
        Ok(m) => match manifest_to_host(cand.origin.clone(), m) {
            Some(h) => (Some(h), attempt("matched")),
            None => (None, attempt("not-rhumb")),
        },
        Err(_) => (None, attempt("bad-response")),
    }
}

#[tauri::command]
pub async fn discover_hosts() -> DiscoveryReport {
    let empty = DiscoveryReport { hosts: Vec::new(), scanned: 0, attempts: Vec::new() };
    let Some(bin) = find_tailscale_bin() else { return empty; };
    let json = match tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new(bin).args(["status", "--json"]).output()
    }).await {
        Ok(Ok(out)) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        _ => return empty,
    };
    let Some(client) = probe_client() else { return empty; };
    let candidates = parse_status_candidates(&json);
    let scanned = candidates.len();
    let results: Vec<(Option<DiscoveredHost>, ProbeAttempt)> =
        futures_util::stream::iter(candidates)
            .map(|c| probe(&client, c))
            .buffer_unordered(8)
            .collect()
            .await;
    let mut hosts = Vec::new();
    let mut attempts = Vec::new();
    for (h, a) in results {
        if let Some(h) = h { hosts.push(h); }
        attempts.push(a);
    }
    DiscoveryReport { hosts, scanned, attempts }
}
```

- [ ] **Step 4: Build + test + commit**

```bash
cd client/src-tauri && cargo test && cargo build
git add src/discover.rs
git commit -m "feat(client): discovery returns a probe report with per-peer outcomes and Tailscale-IP fallback (F14)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: ConnectionScreen consumes the report

**Files:**
- Modify: `client/src/lib/tauri.ts` (types + `discoverHosts` return)
- Modify: `client/src/components/ConnectionScreen.tsx`
- Test: `client/test/ConnectionScreen.test.tsx`

**Interfaces:**
- Consumes: Task 5's `DiscoveryReport`/`ProbeAttempt`.
- Produces: no exported API change.

- [ ] **Step 1: Write the failing tests** — add to `client/test/ConnectionScreen.test.tsx` (match its existing tauri-mock style — it mocks `../src/lib/tauri`; extend the `discoverHosts` mock to return a report):

```tsx
it("renders the pick list when discovery finds hosts", async () => {
  // mock discoverHosts → { hosts: [{baseUrl:"https://b.ts.net", version:"1"}], scanned: 2, attempts: [...] }
  // expect the host to appear as a connect option (as today).
});

it("renders a diagnostic (not a blank) when discovery finds zero hosts", async () => {
  // mock discoverHosts → { hosts: [], scanned: 3, attempts: [
  //   {peer:"box", target:"https://box", outcome:"unreachable"}, ... ] }
  // expect text like "Scanned 3" and the per-peer outcome to be reachable in the DOM.
});
```

- [ ] **Step 2: Run to verify failure** — `cd client && npx vitest run test/ConnectionScreen.test.tsx` — FAIL.

- [ ] **Step 3: Implement.**

`tauri.ts`: add the types and update the binding:

```ts
export interface ProbeAttempt {
  peer: string;
  target: string;
  outcome: "matched" | "unreachable" | "not-rhumb" | "bad-response";
}
export interface DiscoveryReport {
  hosts: DiscoveredHost[];
  scanned: number;
  attempts: ProbeAttempt[];
}

export function discoverHosts(): Promise<DiscoveryReport> {
  return invoke<DiscoveryReport>("discover_hosts");
}
```

`ConnectionScreen.tsx`: hold the whole report; keep `found` derived from `report.hosts`. Replace the state + `scan`:

```tsx
  const [report, setReport] = useState<DiscoveryReport | null>(null);
  const found = report?.hosts ?? [];
  ...
  async function scan() {
    setScanning(true);
    try {
      setReport(await discoverHosts());
    } catch {
      setReport({ hosts: [], scanned: 0, attempts: [] });
    }
    setScanning(false);
  }
```

Import `DiscoveryReport` from `../lib/tauri`. Where the found-list renders, when `!scanning && found.length === 0 && report` show the diagnostic instead of nothing:

```tsx
      {!scanning && found.length === 0 && report && (
        <div className="text-sm text-muted" data-testid="discovery-diagnostic">
          <p>Scanned {report.scanned} tailnet {report.scanned === 1 ? "peer" : "peers"} — none responded as Rhumb.</p>
          {report.attempts.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer">Details</summary>
              <ul className="mt-1 space-y-0.5">
                {report.attempts.map((a, i) => (
                  <li key={i} className="font-mono text-xs">{a.peer} → {a.outcome}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="mt-1">Enter the server URL manually below.</p>
        </div>
      )}
```

(Adapt the exact placement to the component's current JSX — put it in the same region the old empty `found` list occupied, above the manual-entry field which stays unchanged.)

- [ ] **Step 4: Run to verify pass** — `cd client && npx vitest run test/ConnectionScreen.test.tsx` — PASS.

- [ ] **Step 5: Full suite + build + commit**

```bash
cd client && npm test && npm run build
git add src/lib/tauri.ts src/components/ConnectionScreen.tsx test/ConnectionScreen.test.tsx
git commit -m "feat(client): surface discovery diagnostics on zero matches instead of a blank list (F14)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** F8 → T1 (heartbeat) + T2 (sentinel/timeout) + T3 (accounting decouple + reap); F9 → T4; F14 → T5 (report + IP fallback) + T6 (surface). Out-of-scope items (F15, ontology-sync cost, virtualization) have no tasks.
- **Type consistency:** `stream_closed` sentinel identical in T2 (Rust emit) and T3 (hook consume); `DiscoveryReport`/`ProbeAttempt`/outcome strings identical in T5 (Rust) and T6 (TS); `finishTurn(turnId)` single definition used by all three call sites; heartbeat frame `":keepalive\n\n"` identical in T1 impl and the timeout rationale in T2.
- **Known adaptation points (delegated, not placeholders):** T3 and T4 and T6 tests must be wired to each target test file's existing mock/harness shape (fake streams in useChatSessions.test.tsx; container-scroll mocking in Transcript.test.tsx; tauri mock in ConnectionScreen.test.tsx) — the plan names the exact harness to reuse and the assertions to make; it does not reinvent them because those files are authoritative for their own fixtures. T4's `TranscriptMessage.id` is conditional on what `agentEvents.ts` already provides, with an explicit compile-safe fallback.
- **Deliberate limits:** the Rust pump's network behavior is integration-only; T2 ships a constant-bound unit test plus review rather than a fake-socket harness (YAGNI for a 2-line select! change).
