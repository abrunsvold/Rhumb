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
