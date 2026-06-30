mod config;
mod proxy;
mod sse;

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
            proxy::send_message,
            proxy::start_agent_stream,
            proxy::stop_agent_stream,
            proxy::get_registry,
            proxy::start_registry_stream,
            proxy::stop_registry_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
