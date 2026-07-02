use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHost {
    pub base_url: String,
    pub version: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestPaths {
    pub agent: String,
    pub dashboard: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RhumbManifest {
    pub rhumb: bool,
    pub version: String,
    pub paths: ManifestPaths,
}

/// Candidate origins from `tailscale status --json`: every online peer's
/// MagicDNS name (trailing dot trimmed), as an https:// origin.
pub fn parse_status_origins(json: &str) -> Vec<String> {
    let v: Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(peers) = v.get("Peer").and_then(Value::as_object) else {
        return Vec::new();
    };
    peers
        .values()
        .filter(|p| p.get("Online").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|p| p.get("DNSName").and_then(Value::as_str))
        .map(|d| format!("https://{}", d.trim_end_matches('.')))
        .collect()
}

/// Locate the tailscale CLI: macOS app bundle first, then common paths, then $PATH.
pub fn find_tailscale_bin() -> Option<std::path::PathBuf> {
    let candidates = [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
    ];
    for c in candidates {
        let p = std::path::PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    which_tailscale()
}

fn which_tailscale() -> Option<std::path::PathBuf> {
    let out = std::process::Command::new("which").arg("tailscale").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() { None } else { Some(path.into()) }
}

// Client construction can only fail on TLS-backend init; fail soft rather than
// panicking the command handler on a broken environment.
fn probe_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .ok()
}

/// Pure filter behind `probe`: a manifest only counts as a discovered host
/// when it affirms `rhumb: true`.
fn manifest_to_host(origin: String, manifest: RhumbManifest) -> Option<DiscoveredHost> {
    if !manifest.rhumb {
        return None;
    }
    Some(DiscoveredHost { base_url: origin, version: manifest.version })
}

async fn probe(client: &reqwest::Client, origin: String) -> Option<DiscoveredHost> {
    let url = format!("{}/.well-known/rhumb.json", origin);
    let manifest = client.get(&url).send().await.ok()?.json::<RhumbManifest>().await.ok()?;
    manifest_to_host(origin, manifest)
}

#[tauri::command]
pub async fn discover_hosts() -> Vec<DiscoveredHost> {
    let Some(bin) = find_tailscale_bin() else {
        return Vec::new();
    };
    let json = match tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new(bin).args(["status", "--json"]).output()
    })
    .await
    {
        Ok(Ok(out)) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        _ => return Vec::new(),
    };
    let Some(client) = probe_client() else {
        return Vec::new();
    };
    futures_util::stream::iter(parse_status_origins(&json))
        .map(|origin| probe(&client, origin))
        .buffer_unordered(8)
        .filter_map(|h| async move { h })
        .collect()
        .await
}

#[tauri::command]
pub async fn fetch_manifest(base_url: String) -> Result<RhumbManifest, String> {
    let base = base_url.trim_end_matches('/');
    let parsed = reqwest::Url::parse(base).map_err(|_| "not a valid URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("baseUrl must be http(s)".into());
    }
    let url = format!("{}/.well-known/rhumb.json", base);
    let client = probe_client().ok_or_else(|| "could not initialize http client".to_string())?;
    let manifest = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<RhumbManifest>()
        .await
        .map_err(|_| "host answered, but not with a Rhumb manifest".to_string())?;
    if !manifest.rhumb {
        return Err("host answered, but not with a Rhumb manifest".into());
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_online_peers_and_trims_trailing_dots() {
        let json = r#"{
          "Peer": {
            "k1": { "DNSName": "box.tail1234.ts.net.", "Online": true },
            "k2": { "DNSName": "laptop.tail1234.ts.net.", "Online": false },
            "k3": { "Online": true }
          }
        }"#;
        assert_eq!(parse_status_origins(json), vec!["https://box.tail1234.ts.net".to_string()]);
    }

    #[test]
    fn tolerates_malformed_or_peerless_status() {
        assert!(parse_status_origins("not json").is_empty());
        assert!(parse_status_origins("{}").is_empty());
    }

    #[test]
    fn filters_probe_results_by_rhumb_flag() {
        let manifest = |rhumb: bool| RhumbManifest {
            rhumb,
            version: "1.0".into(),
            paths: ManifestPaths { agent: "/agent".into(), dashboard: "/".into() },
        };
        assert!(manifest_to_host("https://a".into(), manifest(false)).is_none());
        assert_eq!(
            manifest_to_host("https://a".into(), manifest(true)),
            Some(DiscoveredHost { base_url: "https://a".into(), version: "1.0".into() })
        );
    }
}
