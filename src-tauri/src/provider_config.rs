use std::fs;
use std::path::PathBuf;

fn get_config_dir() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".ReinAgent")
    } else if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile).join(".ReinAgent")
    } else {
        PathBuf::from("/tmp/ReinAgent")
    }
}

fn get_provider_config_path() -> PathBuf {
    get_config_dir().join("provider_config.json")
}

#[tauri::command]
pub async fn provider_config_load() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = get_provider_config_path();
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn provider_config_save(content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = get_config_dir();
        if !dir.exists() {
            fs::create_dir_all(&dir)
                .map_err(|e| format!("Failed to create config dir {}: {}", dir.display(), e))?;
        }
        let path = dir.join("provider_config.json");
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
    })
    .await
    .map_err(|e| e.to_string())?
}
