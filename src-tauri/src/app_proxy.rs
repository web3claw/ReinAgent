//! 应用级 HTTP 代理（P2-G2 尾巴）：设置页 kv（`reinagent-web-proxy` /
//! `reinagent-web-proxy-no-proxy`）→ 启动早期注入 WebView2 代理参数。
//!
//! WebView2 的网络栈承载**模型 API fetch 与应用渲染层**出口流量——`--proxy-server`
//! 必须在 WebView2 环境初始化前设置（`std::env::set_var` 即可，WebView2 启动时读取），
//! 因此代理修改后需重启应用生效。未配置时**不注入也不读系统环境变量**（直连，
//! 显式清除继承的代理变量，对齐 ZCode「设置页优先于 shell 继承」语义）。
//! No Proxy（不使用代理的地址，逗号分隔）映射到 `--proxy-bypass-list`。

use std::path::PathBuf;

const KV_WEB_PROXY: &str = "reinagent-web-proxy";
const KV_WEB_PROXY_NO_PROXY: &str = "reinagent-web-proxy-no-proxy";

fn kv_db_path() -> PathBuf {
    if let Ok(home) = std::env::var("USERPROFILE") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join(".ReinAgent").join("conversations.db");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join(".ReinAgent").join("conversations.db");
        }
    }
    PathBuf::from(".ReinAgent").join("conversations.db")
}

/// 启动早期读 kv：返回 (proxy, noProxy)，任一未配置为空串。
fn read_proxy_settings() -> (String, String) {
    let conn = match rusqlite::Connection::open_with_flags(
        kv_db_path(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(conn) => conn,
        Err(_) => return (String::new(), String::new()),
    };
    let read = |key: &str| -> String {
        conn.query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| row.get(0))
            .unwrap_or_default()
    };
    (read(KV_WEB_PROXY), read(KV_WEB_PROXY_NO_PROXY))
}

/// WebView2 代理参数注入（在 tauri::Builder 之前调用）。仅 Windows 有 WebView2。
pub fn apply_webview_proxy_env() {
    if !cfg!(target_os = "windows") {
        return;
    }
    let (proxy, no_proxy) = read_proxy_settings();
    let proxy_trimmed = proxy.trim();
    let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();

    if proxy_trimmed.is_empty() {
        // 未配置：显式要求 WebView2 直连（不读系统/继承代理），同时清掉 bypass
        let clear = "--no-proxy-server".to_string();
        let merged = if existing.is_empty() {
            clear
        } else {
            format!("{existing} {clear}")
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
        let _ = std::env::remove_var("WEBVIEW2_PROXY_BYPASS_LIST");
        return;
    }

    let mut args = format!("--proxy-server={proxy_trimmed}");
    let no_proxy_trimmed = no_proxy.trim();
    if !no_proxy_trimmed.is_empty() {
        // 逗号分隔规则直接映射 WebView2 bypass list（分号分隔）
        let bypass = no_proxy_trimmed.split(',').map(str::trim).collect::<Vec<_>>().join(";");
        if !bypass.is_empty() {
            args.push_str(&format!(" --proxy-bypass-list={bypass}"));
        }
        std::env::set_var("WEBVIEW2_PROXY_BYPASS_LIST", no_proxy_trimmed);
    }
    let merged = if existing.is_empty() {
        args
    } else {
        // 已有参数（外部传入的调试参数等）原样保留在前
        format!("{existing} {args}")
    };
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
}
