use crate::sse::SseParser;
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

/// Accumulates raw bytes and yields the largest valid UTF-8 prefix as a String,
/// keeping any trailing incomplete multibyte sequence buffered for the next call.
pub struct Utf8Buffer {
    buf: Vec<u8>,
}

impl Utf8Buffer {
    pub fn new() -> Self {
        Utf8Buffer { buf: Vec::new() }
    }

    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.buf.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.buf) {
                Ok(s) => {
                    out.push_str(s);
                    self.buf.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.buf[..valid]).unwrap());
                    match e.error_len() {
                        Some(bad) => {
                            // genuinely invalid byte(s): emit a replacement and skip past them
                            out.push('\u{FFFD}');
                            self.buf.drain(..valid + bad);
                            // continue loop to process remaining bytes
                        }
                        None => {
                            // incomplete trailing sequence: keep it buffered for the next chunk
                            self.buf.drain(..valid);
                            break;
                        }
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod utf8_tests {
    use super::*;

    #[test]
    fn reassembles_a_multibyte_char_split_across_chunks() {
        // '✅' is E2 9C 85
        let mut b = Utf8Buffer::new();
        assert_eq!(b.push(&[0xE2, 0x9C]), ""); // incomplete, nothing yet
        assert_eq!(b.push(&[0x85]), "✅");
    }

    #[test]
    fn passes_ascii_through() {
        let mut b = Utf8Buffer::new();
        assert_eq!(b.push(b"data: 1\n\n"), "data: 1\n\n");
    }

    #[test]
    fn skips_an_invalid_byte_instead_of_stalling() {
        let mut b = Utf8Buffer::new();
        // 0xFF is never valid UTF-8; output must still advance and include later data
        let out = b.push(&[b'a', 0xFF, b'b']);
        assert!(out.starts_with('a'));
        assert!(out.ends_with('b'));
        assert_eq!(b.push(b"c"), "c"); // not stalled
    }
}

#[cfg(test)]
mod session_id_tests {
    use super::valid_session_id;

    #[test]
    fn accepts_uuid_like_ids() {
        assert!(valid_session_id("3ed7a8ac-2e68-4bb8-b1a8-85f252647b34"));
        assert!(valid_session_id("a"));
    }

    #[test]
    fn rejects_traversal_empty_and_overlong() {
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("../etc"));
        assert!(!valid_session_id("a/b"));
        assert!(!valid_session_id("a?x=1"));
        assert!(!valid_session_id(&"a".repeat(65)));
    }
}

#[derive(Default)]
pub struct StreamState {
    pub agent: Mutex<HashMap<String, CancellationToken>>,
    pub session: Mutex<HashMap<String, CancellationToken>>,
    pub registry: Mutex<Option<CancellationToken>>,
    pub pending: Mutex<Option<CancellationToken>>,
    pub infra: Mutex<Option<CancellationToken>>,
}

// Resolve a request target against the PERSISTED config, not the per-call base.
// The webview passes the base it read from get_config; we require it to match the
// stored value, so a compromised/hostile webview cannot redirect the proxy at an
// arbitrary host (SSRF, e.g. the cloud metadata endpoint). Returns the full URL
// and the control token to present as a Bearer header.
fn agent_target(
    app: &tauri::AppHandle,
    passed: &str,
    suffix: &str,
) -> Result<(String, Option<String>), String> {
    let cfg = crate::load_config(app);
    // Check unconfigured state on base_url itself: agent_base() is never empty
    // (an empty origin still derives "/agent"), so testing the derived value
    // would let a relative URL through to an opaque reqwest parse error.
    if cfg.base_url.is_empty() {
        return Err("no host configured — connect first".into());
    }
    let base = cfg.agent_base();
    if passed.trim_end_matches('/') != base {
        return Err("agent base does not match the configured host".into());
    }
    Ok((format!("{}{}", base, suffix), cfg.control_token))
}

fn dashboard_target(
    app: &tauri::AppHandle,
    passed: &str,
    suffix: &str,
) -> Result<(String, Option<String>), String> {
    let cfg = crate::load_config(app);
    if cfg.base_url.is_empty() {
        return Err("no host configured — connect first".into());
    }
    let base = cfg.dashboard_base();
    if passed.trim_end_matches('/') != base {
        return Err("dashboard base does not match the configured host".into());
    }
    Ok((format!("{}{}", base, suffix), cfg.control_token))
}

// Identity-mode hosts require Sec-Rhumb-Control on shell-only routes; browsers
// forbid page JS from sending Sec-* headers, so only this proxy can. Sent on
// every request for uniformity. The bearer token applies in dev mode only.
fn shell_request(mut req: reqwest::RequestBuilder, bearer: &Option<String>) -> reqwest::RequestBuilder {
    req = req.header("Sec-Rhumb-Control", "1");
    if let Some(t) = bearer {
        req = req.bearer_auth(t);
    }
    req
}

// Mirrors the agent-host route validation (/^[A-Za-z0-9-]{1,64}$/) so a
// malformed id never reaches URL construction.
fn valid_session_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

// A healthy stream sends a heartbeat every ~15s (agent-host SSE keepalive), so
// >40s of total byte-silence means the socket is wedged, not merely quiet.
const PUMP_IDLE_TIMEOUT: Duration = Duration::from_secs(40);

async fn pump(url: String, bearer: Option<String>, on_event: Channel<Value>, token: CancellationToken) {
    let client = reqwest::Client::new();
    let req = shell_request(client.get(&url), &bearer);
    let resp = match req.send().await {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut stream = resp.bytes_stream();
    let mut parser = SseParser::new();
    let mut decoder = Utf8Buffer::new();
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
}

#[tauri::command]
pub async fn send_message(
    app: tauri::AppHandle,
    agent_base: String,
    turn_id: String,
    prompt: String,
    session_id: Option<String>,
) -> Result<(), String> {
    let (url, bearer) = agent_target(&app, &agent_base, "/messages")?;
    let mut body = serde_json::json!({ "turnId": turn_id, "prompt": prompt });
    if let Some(sid) = session_id {
        body["sessionId"] = Value::String(sid);
    }
    let client = reqwest::Client::new();
    let req = shell_request(client.post(&url).json(&body), &bearer);
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn start_agent_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, StreamState>,
    agent_base: String,
    turn_id: String,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let (url, bearer) = agent_target(&app, &agent_base, &format!("/turns/{}/stream", turn_id))?;
    let token = CancellationToken::new();
    if let Some(old) = state.agent.lock().unwrap().insert(turn_id.clone(), token.clone()) {
        old.cancel();
    }
    tokio::spawn(async move {
        pump(url, bearer, on_event.clone(), token.clone()).await;
        // The turn stream ended (result/error already forwarded, network drop, or
        // idle timeout). Tell the webview so it can close out turn accounting even
        // if the terminal event never arrived on this channel.
        if !token.is_cancelled() {
            let _ = on_event.send(serde_json::json!({ "type": "stream_closed" }));
        }
    });
    Ok(())
}

#[tauri::command]
pub fn stop_agent_stream(state: tauri::State<'_, StreamState>, turn_id: String) {
    if let Some(tok) = state.agent.lock().unwrap().remove(&turn_id) {
        tok.cancel();
    }
}

#[tauri::command]
pub async fn get_registry(app: tauri::AppHandle, dashboard_base: String) -> Result<Value, String> {
    let (url, bearer) = dashboard_target(&app, &dashboard_base, "/registry")?;
    let client = reqwest::Client::new();
    let req = shell_request(client.get(&url), &bearer);
    req.send()
        .await
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_registry_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, StreamState>,
    dashboard_base: String,
    on_update: Channel<Value>,
) -> Result<(), String> {
    let (url, bearer) = dashboard_target(&app, &dashboard_base, "/registry/stream")?;
    let token = CancellationToken::new();
    if let Some(old) = state.registry.lock().unwrap().replace(token.clone()) {
        old.cancel();
    }
    tokio::spawn(async move { pump(url, bearer, on_update, token).await });
    Ok(())
}

#[tauri::command]
pub fn stop_registry_stream(state: tauri::State<'_, StreamState>) {
    if let Some(tok) = state.registry.lock().unwrap().take() {
        tok.cancel();
    }
}

#[tauri::command]
pub async fn start_pending_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, StreamState>,
    dashboard_base: String,
    on_pending: Channel<Value>,
) -> Result<(), String> {
    let (url, bearer) = dashboard_target(&app, &dashboard_base, "/data/pending/stream")?;
    let token = CancellationToken::new();
    if let Some(old) = state.pending.lock().unwrap().replace(token.clone()) {
        old.cancel();
    }
    tokio::spawn(async move { pump(url, bearer, on_pending, token).await });
    Ok(())
}

#[tauri::command]
pub fn stop_pending_stream(state: tauri::State<'_, StreamState>) {
    if let Some(tok) = state.pending.lock().unwrap().take() {
        tok.cancel();
    }
}

#[tauri::command]
pub async fn resolve_pending(
    app: tauri::AppHandle,
    dashboard_base: String,
    pending_id: String,
    decision: String,
    trust_surface: bool,
) -> Result<(), String> {
    let (url, bearer) = dashboard_target(&app, &dashboard_base, &format!("/data/pending/{}/resolve", pending_id))?;
    let client = reqwest::Client::new();
    let req = shell_request(
        client
            .post(&url)
            .json(&serde_json::json!({ "decision": decision, "trustSurface": trust_surface })),
        &bearer,
    );
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("dashboard host returned {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn start_infra_pending_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, StreamState>,
    agent_base: String,
    on_pending: Channel<Value>,
) -> Result<(), String> {
    let (url, bearer) = agent_target(&app, &agent_base, "/infra/pending/stream")?;
    let token = CancellationToken::new();
    if let Some(old) = state.infra.lock().unwrap().replace(token.clone()) {
        old.cancel();
    }
    tokio::spawn(async move { pump(url, bearer, on_pending, token).await });
    Ok(())
}

#[tauri::command]
pub fn stop_infra_pending_stream(state: tauri::State<'_, StreamState>) {
    if let Some(tok) = state.infra.lock().unwrap().take() {
        tok.cancel();
    }
}

#[tauri::command]
pub async fn resolve_infra_pending(
    app: tauri::AppHandle,
    agent_base: String,
    pending_id: String,
    decision: String,
) -> Result<(), String> {
    let (url, bearer) = agent_target(&app, &agent_base, &format!("/infra/pending/{}/resolve", pending_id))?;
    let client = reqwest::Client::new();
    let req = shell_request(client.post(&url).json(&serde_json::json!({ "decision": decision })), &bearer);
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn start_session_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, StreamState>,
    agent_base: String,
    session_id: String,
    on_event: Channel<Value>,
) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("invalid session id".into());
    }
    let (url, bearer) = agent_target(&app, &agent_base, &format!("/sessions/{}/stream", session_id))?;
    let token = CancellationToken::new();
    if let Some(old) = state.session.lock().unwrap().insert(session_id.clone(), token.clone()) {
        old.cancel();
    }
    tokio::spawn(async move {
        pump(url, bearer, on_event.clone(), token.clone()).await;
        // The stream ended (network drop, host restart, or cancel). Tell the
        // webview so it can retry; harmless if the channel is already gone.
        if !token.is_cancelled() {
            let _ = on_event.send(serde_json::json!({ "type": "stream_closed" }));
        }
    });
    Ok(())
}

#[tauri::command]
pub fn stop_session_stream(state: tauri::State<'_, StreamState>, session_id: String) {
    if let Some(tok) = state.session.lock().unwrap().remove(&session_id) {
        tok.cancel();
    }
}

#[tauri::command]
pub async fn upload_file(
    app: tauri::AppHandle,
    agent_base: String,
    name: String,
    content_base64: String,
) -> Result<String, String> {
    let (url, bearer) = agent_target(&app, &agent_base, "/files")?;
    let client = reqwest::Client::new();
    let req = shell_request(
        client
            .post(&url)
            .json(&serde_json::json!({ "name": name, "contentBase64": content_base64 })),
        &bearer,
    );
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    v.get("path")
        .and_then(|p| p.as_str())
        .map(str::to_string)
        .ok_or_else(|| "agent host returned a malformed upload response".into())
}

#[tauri::command]
pub async fn list_sessions(app: tauri::AppHandle, agent_base: String) -> Result<Value, String> {
    let (url, bearer) = agent_target(&app, &agent_base, "/sessions")?;
    let client = reqwest::Client::new();
    let req = shell_request(client.get(&url), &bearer);
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_transcript(
    app: tauri::AppHandle,
    agent_base: String,
    session_id: String,
) -> Result<Value, String> {
    if !valid_session_id(&session_id) {
        return Err("invalid session id".into());
    }
    let (url, bearer) = agent_target(&app, &agent_base, &format!("/sessions/{}/transcript", session_id))?;
    let client = reqwest::Client::new();
    let req = shell_request(client.get(&url), &bearer);
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_session(
    app: tauri::AppHandle,
    agent_base: String,
    session_id: String,
    title: String,
) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("invalid session id".into());
    }
    let (url, bearer) = agent_target(&app, &agent_base, &format!("/sessions/{}", session_id))?;
    let client = reqwest::Client::new();
    let req = shell_request(client.patch(&url).json(&serde_json::json!({ "title": title })), &bearer);
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn archive_session(
    app: tauri::AppHandle,
    agent_base: String,
    session_id: String,
) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("invalid session id".into());
    }
    let (url, bearer) = agent_target(&app, &agent_base, &format!("/sessions/{}/archive", session_id))?;
    let client = reqwest::Client::new();
    let req = shell_request(client.post(&url), &bearer);
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("agent host returned {}", resp.status()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pump_idle_timeout_tolerates_a_missed_heartbeat() {
        // heartbeat ~15s; timeout must exceed 2 intervals so one dropped beat
        // plus jitter doesn't kill a healthy long-running turn.
        assert!(PUMP_IDLE_TIMEOUT.as_secs() >= 30);
    }
}
