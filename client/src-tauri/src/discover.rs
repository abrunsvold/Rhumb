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

async fn probe(client: &reqwest::Client, cand: Candidate) -> (Option<DiscoveredHost>, ProbeAttempt) {
    let url = format!("{}/.well-known/rhumb.json", cand.origin);
    let attempt = |outcome: &str| ProbeAttempt { peer: cand.peer.clone(), target: cand.origin.clone(), outcome: outcome.into() };
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return (None, attempt("unreachable")),
    };
    match resp.json::<RhumbManifest>().await {
        Ok(m) => match manifest_to_host(cand.origin.clone(), m) {
            Some(h) => (Some(h), attempt("matched")),
            None => (None, attempt("not-rhumb")),
        },
        Err(_) => (None, attempt("bad-response")),
    }
}

/// Assemble the final report from per-candidate probe results: every attempt is
/// kept for diagnostics, but a peer whose name AND IP both resolve to a host
/// contributes only its first match to the pick list (first-match-wins).
fn assemble_report(scanned: usize, results: Vec<(Option<DiscoveredHost>, ProbeAttempt)>) -> DiscoveryReport {
    let mut hosts = Vec::new();
    let mut attempts = Vec::new();
    let mut matched: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (h, a) in results {
        if let Some(h) = h {
            if matched.insert(a.peer.clone()) {
                hosts.push(h);
            }
        }
        attempts.push(a);
    }
    DiscoveryReport { hosts, scanned, attempts }
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
    let scanned = candidates
        .iter()
        .map(|c| c.peer.clone())
        .collect::<std::collections::HashSet<_>>()
        .len();
    let results: Vec<(Option<DiscoveredHost>, ProbeAttempt)> =
        futures_util::stream::iter(candidates)
            .map(|c| probe(&client, c))
            .buffer_unordered(8)
            .collect()
            .await;
    assemble_report(scanned, results)
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
        // one online peer with both a name and an IP yields two candidates...
        assert_eq!(c.len(), 2);
        // ...but "scanned" must count distinct peers, not candidates (IMPORTANT #2)
        let scanned = c.iter().map(|x| x.peer.clone()).collect::<std::collections::HashSet<_>>().len();
        assert_eq!(scanned, 1);
    }

    #[test]
    fn tolerates_malformed_or_peerless_status() {
        assert!(parse_status_candidates("not json").is_empty());
        assert!(parse_status_candidates("{}").is_empty());
    }

    #[test]
    fn assemble_report_dedups_hosts_per_peer_but_keeps_every_attempt() {
        // A peer whose MagicDNS name AND Tailscale IP both probe as a matching
        // Rhumb host must show up once in the pick list (first-match-wins),
        // while both probe attempts remain for the diagnostic view.
        let host = DiscoveredHost { base_url: "https://box.tail1.ts.net".into(), version: "1.0".into() };
        let name_attempt = ProbeAttempt { peer: "box".into(), target: "https://box.tail1.ts.net".into(), outcome: "matched".into() };
        let ip_attempt = ProbeAttempt { peer: "box".into(), target: "https://100.64.0.1".into(), outcome: "matched".into() };
        let results = vec![
            (Some(host.clone()), name_attempt.clone()),
            (Some(DiscoveredHost { base_url: "https://100.64.0.1".into(), version: "1.0".into() }), ip_attempt.clone()),
        ];
        let report = assemble_report(2, results);
        assert_eq!(report.hosts.len(), 1);
        assert_eq!(report.hosts[0], host);
        assert_eq!(report.attempts.len(), 2);
        assert_eq!(report.attempts, vec![name_attempt, ip_attempt]);
    }

    #[test]
    fn report_classifies_manifest_outcomes() {
        // manifest_to_host still gates on rhumb:true (unchanged behavior)
        let m = |rhumb: bool| RhumbManifest { rhumb, version: "1.0".into(), paths: ManifestPaths { agent: "/agent".into(), dashboard: "/".into() } };
        assert!(manifest_to_host("https://a".into(), m(false)).is_none());
        assert_eq!(manifest_to_host("https://a".into(), m(true)), Some(DiscoveredHost { base_url: "https://a".into(), version: "1.0".into() }));
    }
}
