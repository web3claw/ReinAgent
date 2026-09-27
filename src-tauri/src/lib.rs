mod terminal;
mod fs_cmd;
mod provider_config;
mod conversation_store;
mod checkpoint;

use terminal::TerminalState;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 窗口状态记忆仅在非 Linux 平台注册：Linux/Wayland 下合成器不支持应用自定位、
/// 且恢复的尺寸会被 CSD 膨胀放大触发合成器强制改尺寸（详见 PROJECT_CONTEXT 十二），
/// 记忆功能整体失效——停用后每次启动按 tauri.conf.json 的默认 1800×1200 居中。
#[cfg(not(target_os = "linux"))]
fn with_window_state(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.plugin(tauri_plugin_window_state::Builder::default().build())
}

#[cfg(target_os = "linux")]
fn with_window_state(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
}

pub fn run() {
    with_window_state(
        tauri::Builder::default()
            .manage(TerminalState::default())
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_store::Builder::new().build()),
    )
    .invoke_handler(tauri::generate_handler![
            greet,
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            fs_cmd::fs_read_file,
            fs_cmd::fs_write_file,
            fs_cmd::fs_list_dir,
            fs_cmd::fs_execute,
            fs_cmd::fs_pick_folder,
            fs_cmd::fs_pick_files,
            fs_cmd::fs_read_image_preview,
            fs_cmd::fs_import_pasted_file,
            fs_cmd::fs_read_attachment_base64,
            fs_cmd::path_home_dir,
            fs_cmd::fs_read_text_file,
            fs_cmd::fs_clean_reinagent_tmp,
            conversation_store::conversation_sync,
            conversation_store::conversation_load,
            conversation_store::conversation_delete,
            conversation_store::task_sync,
            conversation_store::task_list,
            conversation_store::kv_get_all,
            conversation_store::kv_set_many,
            provider_config::provider_config_load,
            provider_config::provider_config_save,
            checkpoint::checkpoint_begin_turn,
            checkpoint::checkpoint_list,
            checkpoint::checkpoint_diff_stats,
            checkpoint::checkpoint_rewind_code,
            checkpoint::checkpoint_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
