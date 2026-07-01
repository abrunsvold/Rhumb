use crate::sse::SseParser;
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
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

#[derive(Default)]
pub struct StreamState {
    pub agent: Mutex<HashMap<String, CancellationToken>>,
    pub registry: Mutex<Option<CancellationToken>>,
    pub pending: Mutex<Option<CancellationToken>>,
    pub infra: Mutex<Option<CancellationToken>>,
}

async fn pump(url: String, on_event: Channel<Value>, token: CancellationToken) {
    let resp = match reqwest::get(&url).await {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut stream = resp.bytes_stream();
    let mut parser = SseParser::new();
    let mut decoder = Utf8Buffer::new();
    loop {
        tokio::select! {
            _ = token.cancelled() => break,
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        let text = decoder.push(&bytes);
                        for payload in parser.push(&text) {
                            if let Ok(v) = serde_json::from_str::<Value>(&payload) {
                                let _ = on_event.send(v);
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
    if let Some(old) = state.agent.lock().unwrap().insert(turn_id.clone(), token.clone()) {
        old.cancel();
    }
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
    if let Some(old) = state.registry.lock().unwrap().replace(token.clone()) {
        old.cancel();
    }
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

#[tauri::command]
pub async fn start_pending_stream(
    state: tauri::State<'_, StreamState>,
    dashboard_base: String,
    on_pending: Channel<Value>,
) -> Result<(), String> {
    let token = CancellationToken::new();
    if let Some(old) = state.pending.lock().unwrap().replace(token.clone()) {
        old.cancel();
    }
    let url = format!("{}/data/pending/stream", dashboard_base.trim_end_matches('/'));
    tokio::spawn(async move { pump(url, on_pending, token).await });
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
    dashboard_base: String,
    pending_id: String,
    decision: String,
    trust_surface: bool,
) -> Result<(), String> {
    let url = format!("{}/data/pending/{}/resolve", dashboard_base.trim_end_matches('/'), pending_id);
    reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "decision": decision, "trustSurface": trust_surface }))
        .send()
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_infra_pending_stream(
    state: tauri::State<'_, StreamState>,
    agent_base: String,
    on_pending: Channel<Value>,
) -> Result<(), String> {
    let token = CancellationToken::new();
    if let Some(old) = state.infra.lock().unwrap().replace(token.clone()) { old.cancel(); }
    let url = format!("{}/infra/pending/stream", agent_base.trim_end_matches('/'));
    tokio::spawn(async move { pump(url, on_pending, token).await });
    Ok(())
}

#[tauri::command]
pub fn stop_infra_pending_stream(state: tauri::State<'_, StreamState>) {
    if let Some(tok) = state.infra.lock().unwrap().take() { tok.cancel(); }
}

#[tauri::command]
pub async fn resolve_infra_pending(agent_base: String, pending_id: String, decision: String) -> Result<(), String> {
    let url = format!("{}/infra/pending/{}/resolve", agent_base.trim_end_matches('/'), pending_id);
    reqwest::Client::new().post(&url).json(&serde_json::json!({ "decision": decision })).send().await.map(|_| ()).map_err(|e| e.to_string())
}
