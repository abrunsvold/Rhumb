mod config;
mod discover;
mod proxy;
mod sse;

use tauri::Manager;

pub(crate) fn config_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .expect("app config dir")
        .join("config.json")
}

/// Load the persisted config. Used by proxy commands to pin their target host to
/// the operator-configured base rather than trusting a per-call argument.
pub(crate) fn load_config(app: &tauri::AppHandle) -> config::AppConfig {
    config::read_config(&config_path(app))
}

// A base must be an http(s) URL. Reject other schemes so a stored base cannot
// smuggle a non-http target; empty is allowed (unconfigured).
fn valid_base(base: &str) -> bool {
    if base.is_empty() {
        return true;
    }
    match reqwest::Url::parse(base) {
        Ok(u) => matches!(u.scheme(), "http" | "https") && u.host().is_some(),
        Err(_) => false,
    }
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> config::AppConfig {
    config::read_config(&config_path(&app))
}

#[tauri::command]
fn set_config(app: tauri::AppHandle, config: config::AppConfig) -> Result<(), String> {
    if !valid_base(&config.base_url) {
        return Err("baseUrl must be an http(s) URL".into());
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .manage(proxy::StreamState::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            check_health,
            discover::discover_hosts,
            discover::fetch_manifest,
            proxy::send_message,
            proxy::start_agent_stream,
            proxy::stop_agent_stream,
            proxy::get_registry,
            proxy::start_registry_stream,
            proxy::stop_registry_stream,
            proxy::start_pending_stream,
            proxy::stop_pending_stream,
            proxy::resolve_pending,
            proxy::start_infra_pending_stream,
            proxy::stop_infra_pending_stream,
            proxy::resolve_infra_pending,
            proxy::upload_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
