use serde::{Deserialize, Serialize};
use std::path::Path;

fn default_agent_path() -> String {
    "/agent".into()
}
fn default_dashboard_path() -> String {
    "/".into()
}

// One origin, two mount paths. `tailscale serve` fronts both hosts on a single
// hostname; agent_base()/dashboard_base() derive the per-host bases the proxy
// pins its requests to. Legacy configs ({agentBase, dashboardBase}) have no
// baseUrl key, deserialize to an empty base_url, and are treated as
// unconfigured — the user reconnects through the discovery picker.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub base_url: String,
    #[serde(default = "default_agent_path")]
    pub agent_path: String,
    #[serde(default = "default_dashboard_path")]
    pub dashboard_path: String,
    // Dev-mode only (RHUMB_INSECURE_DEV hosts): optional shared secret sent as
    // a Bearer header. Identity-mode hosts ignore it. No UI field — hand-edit
    // config.json for local development.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_token: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            base_url: String::new(),
            agent_path: default_agent_path(),
            dashboard_path: default_dashboard_path(),
            control_token: None,
        }
    }
}

fn join_base(base: &str, path: &str) -> String {
    let b = base.trim_end_matches('/');
    let p = path.trim_end_matches('/');
    if p.is_empty() {
        b.to_string()
    } else if p.starts_with('/') {
        format!("{b}{p}")
    } else {
        format!("{b}/{p}")
    }
}

impl AppConfig {
    pub fn agent_base(&self) -> String {
        join_base(&self.base_url, &self.agent_path)
    }
    pub fn dashboard_base(&self) -> String {
        join_base(&self.base_url, &self.dashboard_path)
    }
}

/// Merge a config update with what is already on disk: an update that omits
/// controlToken keeps the existing one. The token is hand-edited for dev mode
/// and no UI writes it, so a connect/disconnect cycle must not silently wipe
/// it; clearing requires editing config.json directly.
pub fn merge_preserving_token(new: AppConfig, old: AppConfig) -> AppConfig {
    AppConfig {
        control_token: new.control_token.or(old.control_token),
        ..new
    }
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
            base_url: "https://box.tail1234.ts.net".into(),
            agent_path: "/agent".into(),
            dashboard_path: "/".into(),
            control_token: Some("tok".into()),
        };
        write_config(&path, &cfg).unwrap();
        assert_eq!(read_config(&path), cfg);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn derives_agent_and_dashboard_bases() {
        let cfg = AppConfig {
            base_url: "https://box.ts.net/".into(),
            agent_path: "/agent".into(),
            dashboard_path: "/".into(),
            control_token: None,
        };
        assert_eq!(cfg.agent_base(), "https://box.ts.net/agent");
        assert_eq!(cfg.dashboard_base(), "https://box.ts.net");
    }

    #[test]
    fn legacy_two_url_config_reads_as_unconfigured() {
        let dir = std::env::temp_dir().join(format!("rhumb-cfg-legacy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, r#"{"agentBase":"http://a:8787","dashboardBase":"http://d:8788"}"#).unwrap();
        assert_eq!(read_config(&path).base_url, "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_preserves_omitted_token_and_honors_explicit_one() {
        let old = AppConfig { control_token: Some("dev-tok".into()), ..AppConfig::default() };
        let disconnect = AppConfig::default(); // no token field, e.g. disconnect reset
        assert_eq!(
            merge_preserving_token(disconnect, old.clone()).control_token,
            Some("dev-tok".into())
        );
        let explicit = AppConfig { control_token: Some("new-tok".into()), ..AppConfig::default() };
        assert_eq!(merge_preserving_token(explicit, old).control_token, Some("new-tok".into()));
    }

    #[test]
    fn missing_paths_default_to_spec_layout() {
        let dir = std::env::temp_dir().join(format!("rhumb-cfg-defaults-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, r#"{"baseUrl":"https://box.ts.net"}"#).unwrap();
        let cfg = read_config(&path);
        assert_eq!(cfg.agent_path, "/agent");
        assert_eq!(cfg.dashboard_path, "/");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
