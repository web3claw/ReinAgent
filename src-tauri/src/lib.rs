mod terminal;
mod fs_cmd;
mod fs_search;
mod commands;
mod agents_md;
mod bg_process;
#[cfg(test)]
mod bg_process_tests;
mod provider_config;
mod conversation_store;
mod checkpoint;
mod automation;
mod mcp;
mod memory;
mod skills;
mod history_search;
mod hub_http;

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
            .plugin(tauri_plugin_store::Builder::new().build())
            .plugin(tauri_plugin_notification::init()),
    )
    .setup(|app| {
        // 自动化调度线程：每 20s 轮询到期任务，经 automation-due 事件派发前端执行
        automation::start_scheduler(app.handle().clone());
        // 内置技能种子（对齐 LiveAgent setup：skills-installer / skills-creator /
        // liveagent-code-review 写入 ~/.ReinAgent/skills，失败不阻断启动）
        if let Err(error) = skills::ensure_builtin_agent_skills_sync() {
            eprintln!("failed to seed builtin skills: {error}");
        }
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
            fs_cmd::fs_delete_file,
            fs_search::fs_glob,
            fs_search::fs_grep,
            commands::commands_scan,
            agents_md::agents_md_read,
            bg_process::bg_spawn,
            bg_process::bg_output,
            bg_process::bg_stop,
            bg_process::bg_list,
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
            hub_http::hub_fetch_json,
            memory::memory_list,
            memory::memory_read,
            memory::memory_search,
            memory::memory_write,
            memory::memory_update,
            memory::memory_delete,
            memory::memory_delete_project,
            memory::memory_accept,
            memory::memory_apply_batch,
            memory::memory_organize_run_create,
            memory::memory_organize_run_update,
            memory::memory_organize_run_list,
            memory::memory_organize_run_read,
            memory::memory_organize_run_clear_history,
            memory::memory_organize_due_claim,
            memory::memory_organize_due_complete,
            memory::memory_index_overview,
            memory::memory_paths_info,
            memory::memory_recent_rejections,
            memory::memory_today_local_date,
            memory::memory_today_daily,
            memory::memory_quota_summary,
            memory::memory_wipe_all,
            mcp::mcp_save_servers,
            mcp::mcp_list_servers,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            mcp::mcp_test_server,
            mcp::mcp_stop_server,
            mcp::mcp_restart_server,
            mcp::mcp_runtime_status,
            skills::system_manage_skill,
            skills::system_read_skill_text,
            skills::system_read_skill_metadata,
            skills::system_ensure_builtin_skills,
            skills::mcp_scan_external,
            skills::mcp_scan_config_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
