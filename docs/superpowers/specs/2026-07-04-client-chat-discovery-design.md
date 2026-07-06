# Client batch: chat send/transcript resilience + discovery diagnostics

**Date:** 2026-07-04 · **Status:** approved design · **Branch:** `fix/client-chat-discovery` (stacked on `chore/platform-sweep`, PR #26)
**Fixes:** F8 (HIGH), F9 (MEDIUM), F14 (HIGH, chip `task_c1709bf9`) from [docs/dogfood/2026-07-04-day2-filament.md](../../dogfood/2026-07-04-day2-filament.md).

Root causes were mapped by exploration before this design; each fix below cites the mechanism it closes.

## F8 — the chat turn stream can wedge the operator loop

**Mechanism.** The per-turn SSE stream is the fragile one. Unlike the session stream, `start_agent_stream` (proxy.rs:221) sends no `stream_closed` sentinel on close, and the shared `pump` (proxy.rs:168) has no idle timeout — a silently half-closed socket blocks in `stream.next()` forever. Turn accounting (`openTurns` decrement → clears the `busy`/"thinking" state) fires **only** on a terminal `result`/`error` arriving on the turn stream (useChatSessions.ts:178). But once a tab is promoted, the session stream *also* delivers that terminal event (documented double-delivery) — so a stalled turn stream leaves `busy` stuck **even though the result already arrived and rendered via the session stream**. The stalled turn also leaks: its `turnStops` entry and Rust `pump` task are never cancelled. Compounding: agent-host emits no SSE heartbeat (sse.ts writes only on real events), so "no bytes" is ambiguous between "wedged" and "quietly working."

**Fix (defense-in-depth — make wedging structurally impossible):**

1. **Agent-host heartbeat.** Both the turn stream (`/turns/:id/stream`) and session stream (`/sessions/:id/stream`) write a periodic SSE comment line (`:keepalive\n\n`, ~15s, cleared on `res` close). Comment frames are ignored by the Rust `SseParser` (verified: `sse.rs` emits only `data:` lines; a `:` line yields nothing) and never reach the reducer. This makes byte-silence genuinely mean "dead."
2. **Turn-stream sentinel + pump idle timeout (Rust).** `start_agent_stream` mirrors `start_session_stream`: after `pump` returns, send `{type:"stream_closed"}` unless cancelled. `pump` wraps `stream.next()` in a `tokio::time::timeout` (~40s — tolerant of one missed 15s heartbeat plus jitter); on timeout it ends the loop (→ the caller's sentinel fires). The session stream benefits too (it already reconnects on close).
3. **Decouple turn-done from the turn stream (hook).** Turn accounting (`openTurns -1`, `turnStops`/`turnKey` cleanup, idempotent by `turnId`) fires when a terminal `result`/`error` arrives on **either** the turn stream **or** the promoted tab's session stream — whichever first. This is the load-bearing fix: the reliable channel closes the turn out. Plus: on a turn stream `stream_closed` with no terminal event yet, clear that turn's accounting anyway (busy cannot outlive the stream).
4. **Leaked-turn reaping (hook).** `turnStops` entries for turns that never terminated are stopped on unmount (present) and additionally when their tab is closed (present via `close()`); add a guard so a `stream_closed`/timeout path always deletes the `turnStops`/`turnKey` entry.

**Tests (useChatSessions.test.tsx, jsdom):** result delivered on the session stream clears busy when the turn stream never delivers it; turn `stream_closed` with no result clears busy; sending a reply immediately after a turn completes goes busy→idle. Rust: the sentinel-on-close path is covered by an assertion that `start_agent_stream`'s spawned task sends `stream_closed` (factor the "send sentinel unless cancelled" into a testable helper mirroring how the session path is structured); the pump idle-timeout constant is asserted. Agent-host: heartbeat writes a `:` frame on the interval and stops on close (fake timer + fake `res`).

## F9 — transcript does not auto-follow and can silently freeze

**Mechanism.** `Transcript.tsx:82-91` — `stickToBottom` latches `false` on *any* scroll event landing >80px from bottom, including transient reflow/programmatic scrolls, and only re-latches when the user manually scrolls back near bottom. The auto-scroll effect depends on the `messages` array reference, which only changes when events reduce onto the *visible* tab's key — so the F8 mis-routing also starves this effect. Messages are keyed by array index (latent reorder-misrender risk). No "jump to latest" affordance exists; recovery required the undiscoverable sidebar-toggle reflow trick.

**Fix:**
1. **Unlatch only on genuine user scroll.** Track `stickToBottom` off real user-initiated events on the scroll container (`wheel`, `touchmove`, keyboard paging) rather than the raw `scroll` event; re-latch `true` when the user returns within threshold of the bottom. Transient reflow no longer strands it false.
2. **"Jump to latest" affordance.** A pill appears when `stickToBottom` is false **and** new messages have arrived since it unlatched; clicking scrolls to bottom and re-latches. Replaces the folk remedy with a discoverable control (finding explicitly requests this).
3. **Stable message keys.** Key the message map by a stable per-message id (append order is stable today; the key removes the reorder risk and is correct).
4. The "new events force a re-render" half is delivered by F8 fix #3 (events reliably reach the visible tab's key → the effect's `messages` dependency fires).

**Tests (Transcript.test.tsx):** with `stickToBottom` true a new message scrolls to bottom; with it false a new message does not scroll but the jump affordance appears; clicking the affordance scrolls and hides it; a programmatic reflow does not unlatch `stickToBottom`.

## F14 — tailnet autodiscovery fails silently

**Mechanism.** Silent at three layers: `parse_status_origins` (discover.rs:28) returns `[]` on any JSON-shape surprise; `probe` (discover.rs:88) swallows every failure via `.ok()?`; `ConnectionScreen.scan` (ConnectionScreen.tsx:21) catches invoke errors into `setFound([])`. The manifest endpoint is served **open** (pre-identity, like `/healthz` — dashboard-host/src/server.ts), so a reachable box *should* match; the real triggers (peer not `Online` / missing `DNSName` / a `tailscale status` shape difference, or serve-name routing) are never surfaced, and only the MagicDNS name is probed (never the Tailscale IP).

**Fix (loud + fallback):**
1. **`discover_hosts` returns a report, not a bare list.** New shape `{ hosts: DiscoveredHost[], scanned: number, attempts: ProbeAttempt[] }` where `ProbeAttempt = { peer: string, target: string, outcome: "matched" | "unreachable" | "not-rhumb" | "bad-response" }`. `probe` records the outcome instead of collapsing to `None`. `parse_status_origins` becomes `parse_status_candidates` yielding, per online peer, both its MagicDNS-name origin **and** its first Tailscale-IP origin (both `https://`), tagged with the peer label for the report.
2. **IP fallback.** Each online peer is probed at both its MagicDNS name and its Tailscale IP; first match wins for that peer. Widens the hit rate for the DNSName/serve-name-mismatch case without reworking the probe.
3. **ConnectionScreen surfaces the report.** On zero matches, render "Scanned N tailnet peers — none responded as Rhumb" with an expandable per-peer reason list, instead of a blank result. Manual Server URL entry stays the always-present reliable path (unchanged).

**Tests:** Rust — `parse_status_candidates` yields name+IP per online peer and skips offline/incomplete peers; report assembly from a mix of matched/unreachable/not-rhumb outcomes. React (ConnectionScreen.test.tsx) — a zero-match report renders the diagnostic and peer reasons, not an empty list; a report with hosts renders the pick list as before.

## Verification & scope

- Client `vitest` suites, `cargo test`, `tsc` + `cargo build` per task; whole-branch review at the end.
- **Live GUI verification rides the next dogfood run** (novel-field migration), same call as the platform sweep's behavioral items — the fixes are logic-covered by unit tests, and a dedicated box+computer-use GUI session is disproportionately costly. The heartbeat + client ship together in that deploy (whole-repo tarball), avoiding version skew between the client idle timeout and the server heartbeat.
- **Out of scope:** F15 (deploy.sh on-ramp — own cycle); the ontology-sync cost follow-up (task_0055b835); any transcript virtualization (not needed at current message volumes); reworking discovery beyond IP fallback + diagnostics.

## Task decomposition (for the plan)

T1 agent-host SSE heartbeat · T2 Rust turn-stream sentinel + pump idle timeout · T3 hook turn-accounting decouple + leak reap (F8 core) · T4 Transcript follow + jump + stable keys (F9) · T5 discovery report + IP fallback (Rust) · T6 ConnectionScreen diagnostic render (F14 surface). F8 = T1–T3; F9 = T4; F14 = T5–T6.
