mod terminal;
mod fs_cmd;
mod provider_config;
mod conversation_store;
mod checkpoint;
mod automation;
mod mcp;
mod memory;
mod skills;
mod history_search;

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
    .setup(|app| {
        // 自动化调度线程：每 20s 轮询到期任务，经 automation-due 事件派发前端执行
        automation::start_scheduler(app.handle().clone());
        Ok(())
    })
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
            checkpoint::checkpoint_clear,
            automation::automation_list,
            automation::automation_create,
            automation::automation_update,
            automation::automation_delete,
            automation::automation_set_enabled,
            automation::automation_run_now,
            automation::automation_list_runs,
            automation::automation_run_finished,
            history_search::chat_history_search,
            mcp::mcp_save_servers,
            mcp::mcp_list_servers,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            mcp::mcp_test_server,
            mcp::mcp_stop_server,
            memory::memory_list,
            memory::memory_read,
            memory::memory_write,
            memory::memory_update,
            memory::memory_delete,
            memory::memory_index_overview,
            skills::skills_list,
            skills::skills_read,
            skills::skills_save,
            skills::skills_delete,
            skills::skills_set_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
