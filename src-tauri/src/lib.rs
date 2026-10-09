mod terminal;
mod fs_cmd;
mod console_decode;
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
mod web_tools;
mod usage_stats;
mod stt;
mod remote_server;
mod fs_base64;
mod import_sqlite;
mod fs_tree;
mod git_panel;
mod hooks;
mod plugins;
mod clipboard_image;
mod browser;
mod system_info;
mod app_tray;
mod app_proxy;
mod llm_proxy;
mod hide_to_tray;
mod self_update;
#[cfg(test)]
mod git_panel_tests;
#[cfg(test)]
mod fs_cmd_tests;
#[cfg(test)]
mod usage_stats_tests;
#[cfg(test)]
mod web_tools_tests;

use terminal::TerminalState;

/// 单实例聚焦用的主进程句柄（single-instance 回调在第二进程上下文触发，
/// 无法直接拿窗口——setup 时保存本实例句柄，回调里取用）。
static SINGLE_APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// 将主窗口恢复并聚焦呈现于桌面最前端（跨平台增强）
pub fn focus_main_window(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    #[cfg(target_os = "linux")]
    {
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            use gtk::prelude::*;
            if let Ok(gtk_window) = win.gtk_window() {
                gtk_window.show();
                gtk_window.deiconify();
                gtk_window.present();
            }
            gdk::notify_startup_complete();
        });
        // 穿透 GNOME 焦点防窃取：短暂置顶后恢复正常层级
        let _ = window.set_always_on_top(true);
        let _ = window.set_always_on_top(false);
    }
}

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
    // 代理注入必须最先执行（WebView2 环境在 builder 初始化时读取这些变量）
    app_proxy::apply_webview_proxy_env();
    // Linux/Wayland：强制 X11 后端（XWayland）。wry 0.57 的多 webview 子控件
    // （内嵌浏览器面板）在纯 Wayland 下 set_bounds 被忽略、固定挂在容器底部
    // 默认布局位置；x11 路径才有 move_/resize 定位能力。当前环境 100% 缩放，
    // XWayland 无模糊风险（详见 PROJECT_CONTEXT「Linux 分支移植」）。
    #[cfg(target_os = "linux")]
    if std::env::var("GDK_BACKEND").unwrap_or_default() != "x11" {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    #[cfg(target_os = "linux")]
    {
        gtk::glib::set_prgname(Some("ReinAgent"));
        gtk::glib::set_application_name("ReinAgent");
    }
    with_window_state(
        tauri::Builder::default()
            // 单实例锁（P2-G2）：第二个进程启动时回调 → 聚焦已有主窗口后退出；
            // 必须最先注册（官方要求）。保证任务栏只有一个应用图标。
            .plugin({
                tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                    use tauri::Manager as _;
                    if let Some(window) = app.get_webview_window("main") {
                        focus_main_window(&window);
                    }
                })
            })
            .manage(TerminalState::default())
            .manage(std::sync::Arc::new(stt::SttManager::default()))
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_http::init())
            .plugin(tauri_plugin_store::Builder::new().build())
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_process::init())
            // 自更新不走 tauri-plugin-updater（它只会下载安装包再交系统安装器）。
            // 本项目分发裸二进制 / macOS .app zip，替换逻辑见 self_update.rs。
            // 麦克风权限默认放行：WebKitGTK 对 getUserMedia 请求**默认拒绝**（Linux 取流
            // 直接 NotAllowedError），WebView2 则弹「是否允许录音」询问框。显式 Allow
            // 让两端都静默放行语音输入；其余权限（摄像头/定位/通知等）保持各平台默认。
            .on_permission_request(|_webview, kind| match kind {
                tauri::webview::PermissionKind::Microphone => {
                    tauri::webview::PermissionResponse::Allow
                }
                _ => tauri::webview::PermissionResponse::Default,
            }),
    )
    .setup(|app| {
        // Linux：把「联网代理」设置注入 WebKitGTK 会话（内置浏览器 + 主 webview 共用）。
        // 必须在页面加载前设置 → 放在 setup 最前面（webview 已创建、尚未导航完成）。
        #[cfg(target_os = "linux")]
        app_proxy::apply_webkit_proxy_settings(app.handle());
        // 远程访问服务：恢复持久化配置（开启则启动监听）
        remote_server::restore_on_startup(app.handle());
        // 单实例：保存本实例句柄（二次启动回调聚焦用）
        let _ = SINGLE_APP_HANDLE.set(app.handle().clone());
        // dev 构建（`bun run tauri dev` 走 debug profile）在窗口标题标注 (dev)，
        // 便于与 release 实例区分；release 编译期剔除，保持 tauri.conf.json 的 "ReinAgent"。
        #[cfg(debug_assertions)]
        {
            use tauri::Manager as _;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("ReinAgent (dev)");
            }
        }
        // 自更新遗留清理：上次更新移走的旧 exe（Windows 运行中被占用删不掉）与
        // 中断的 .new 下载残留——此时新进程已就位，旧 exe 一般已退出。
        self_update::cleanup_stale();
        // 恢复「关闭时隐藏到托盘」设置（缺省开启）
        hide_to_tray::restore_hide_to_tray();
        // LLM 流式本地反代：SDK 出站走 127.0.0.1 反代直连上游（绕开 webview 网络栈
        // 的 CORS 与 tauri-plugin-http 的 IPC 逐块中继——后者高吞吐下会无声截断流）
        if let Err(error) = llm_proxy::start() {
            eprintln!("failed to start llm local proxy: {error}");
        }
        // 系统托盘（P2-G2）：菜单 + 左键切换主窗口显隐；失败如实打日志不阻断启动
        if let Err(error) = app_tray::setup_tray(app) {
            eprintln!("failed to setup system tray: {error}");
        }
        // 关闭窗口 → 隐藏到托盘（Windows + Linux；托盘菜单「退出」仍完全退出，
        // 不受此拦截影响）。仅托盘创建成功时拦截——托盘不可用的系统上隐藏窗口
        // 会让应用无法恢复，保持直接退出。
        if app_tray::is_tray_available() {
            use tauri::Manager;
            let main_window = app.get_webview_window("main").expect("main window");
            let window_clone = main_window.clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if hide_to_tray::is_hide_to_tray_enabled() {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                }
            });
        }
        // 自动化调度线程：每 20s 轮询到期任务，经 automation-due 事件派发前端执行
        automation::start_scheduler(app.handle().clone());
        // Windows dev 构建：补注册 AUMID（未注册 AppId 的 Toast 只进通知中心不弹横幅）
        #[cfg(target_os = "windows")]
        git_panel::ensure_windows_aumid_registered();
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
            fs_cmd::fs_path_exists,
            fs_cmd::open_in_file_manager,
            hide_to_tray::get_hide_to_tray,
            llm_proxy::llm_proxy_info,
            hide_to_tray::set_hide_to_tray,
            fs_cmd::shell_detect,
            fs_cmd::fs_write_file,
            fs_cmd::fs_list_dir,
            import_sqlite::import_sqlite_query,
            import_sqlite::import_read_text_auto,
            import_sqlite::import_sqlite_execute,
            import_sqlite::import_delete_path,
            fs_cmd::fs_execute,
            fs_cmd::fs_pick_folder,
            fs_cmd::fs_pick_files,
            fs_cmd::fs_read_image_preview,
            fs_cmd::fs_import_pasted_file,
            fs_cmd::fs_read_attachment_base64,
            fs_cmd::path_home_dir,
            remote_server::remote_server_status,
            remote_server::remote_server_config,
            remote_server::remote_bridge_state,
            remote_server::remote_bridge_approval,
            remote_server::remote_bridge_snapshot,
            remote_server::remote_bridge_notify_tasks,
            remote_server::remote_bridge_answer_snapshot,
            remote_server::remote_bridge_answer_state,
            remote_server::remote_bridge_send_rejected,
            stt::stt_start,
            stt::stt_send_audio,
            stt::stt_stop,
            stt::stt_cancel,
            stt::stt_request_microphone_permission,
            stt::settings_test_stt,
            fs_cmd::fs_read_text_file,
            fs_cmd::fs_read_file_ends,
            fs_cmd::import_env_lookup,
            fs_cmd::ccswitch_read_providers,
            fs_cmd::fs_clean_reinagent_tmp,
            fs_cmd::fs_delete_file,
            fs_cmd::fs_remove_entry,
            fs_cmd::fs_create_dir,
            fs_cmd::fs_rename,
            fs_search::fs_glob,
            fs_search::fs_grep,
            commands::commands_scan,
            agents_md::agents_md_read,
            bg_process::bg_spawn,
            bg_process::bg_output,
            bg_process::bg_stop,
            bg_process::bg_list,
            web_tools::web_fetch,
            web_tools::web_search,
            hooks::hook_execute,
            hooks::hook_http_execute,
            browser::browser_open,
            browser::browser_set_bounds,
            browser::browser_navigate,
            browser::browser_eval,
            browser::browser_read_page,
            browser::browser_screenshot,
            browser::browser_current_url,
            browser::browser_close,
            browser::browser_is_open,
            plugins::plugin_list,
            plugins::plugin_install_from_dir,
            plugins::plugin_install_from_git,
            system_info::system_info,
            plugins::plugin_uninstall,
            self_update::update_check,
            self_update::update_install,
            self_update::update_restart,
            usage_stats::usage_snapshot,
            usage_stats::usage_reset,
            fs_base64::fs_read_base64_file,
            fs_tree::fs_tree_dir,
            git_panel::git_status,
            git_panel::git_branch_list,
            git_panel::git_checkout,
            git_panel::git_log,
            git_panel::git_branch_list_v2,
            git_panel::git_branch_switch,
            git_panel::git_numstat,
            git_panel::git_identity,
            git_panel::git_stage,
            git_panel::git_commit,
            git_panel::git_init,
            git_panel::git_push,
            git_panel::git_diff_patch,
            git_panel::notify_send,
            git_panel::notify_beep,
            git_panel::git_diff_file,
            conversation_store::conversation_sync,
            conversation_store::conversation_load,
            conversation_store::conversation_load_page,
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
            skills::mcp_scan_config_file,
            clipboard_image::clipboard_read_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
