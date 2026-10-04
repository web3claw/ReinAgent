//! 关闭窗口时隐藏到托盘（P2-G2 尾巴）。
//!
//! Windows + Linux 生效（以托盘创建成功为前提，见 app_tray::is_tray_available）：
//! 点击关闭按钮或关闭窗口快捷键时隐藏窗口而非退出；托盘菜单的「退出」仍完全
//! 退出。设置存 kv `reinagent-hide-to-tray`（缺省开启）。TS 侧通过
//! `set_hide_to_tray` 命令切换，Rust 侧缓存即时生效。

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

static HIDE_TO_TRAY: AtomicBool = AtomicBool::new(true);

const KV_HIDE_TO_TRAY: &str = "reinagent-hide-to-tray";

pub fn is_hide_to_tray_enabled() -> bool {
    HIDE_TO_TRAY.load(Ordering::Relaxed)
}

/// 从 kv 恢复设置（启动时调用一次）。
pub fn restore_hide_to_tray() {
    let enabled = if let Ok(conn) = crate::conversation_store::db_conn() {
        conn.query_row(
            "SELECT value FROM kv WHERE key = ?1",
            [KV_HIDE_TO_TRAY],
            |row| row.get::<_, String>(0),
        )
        .map(|v| v != "0")
        .unwrap_or(true)
    } else {
        true
    };
    HIDE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HideToTrayResult {
    pub enabled: bool,
}

#[tauri::command]
pub fn get_hide_to_tray() -> HideToTrayResult {
    HideToTrayResult { enabled: is_hide_to_tray_enabled() }
}

#[tauri::command]
pub fn set_hide_to_tray(enabled: bool) -> HideToTrayResult {
    HIDE_TO_TRAY.store(enabled, Ordering::Relaxed);
    if let Ok(conn) = crate::conversation_store::db_conn() {
        let _ = conn.execute(
            "INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)",
            [KV_HIDE_TO_TRAY, if enabled { "1" } else { "0" }],
        );
    }
    HideToTrayResult { enabled }
}
