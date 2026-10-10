//! 应用级 HTTP 代理（P2-G2 尾巴）：设置页 kv（`reinagent-web-proxy` /
//! `reinagent-web-proxy-no-proxy`）→ 注入内置 webview 的网络栈代理。
//!
//! - **Windows（WebView2）**：启动早期注入 `--proxy-server` / `--proxy-bypass-list`
//!   环境变量，WebView2 环境初始化时读取。未配置时**不注入也不读系统环境变量**
//!   （直连，显式清除继承的代理变量，对齐 ZCode「设置页优先于 shell 继承」语义）。
//! - **Linux（WebKitGTK）**：`apply_webkit_proxy_settings` 在 GTK/WebContext 创建前
//!   设置默认 WebsiteDataManager 的网络代理（v2_32 API）。WebKitGTK 的代理是
//!   **会话级、创建后不可改**——所以与 Windows 一样：改设置需重启应用生效。
//!   未配置时置 `NoProxy`（显式直连，不跟随系统/环境代理）。
//!
//! 注：内置浏览器（browser.rs 的 child webview）与主 webview 共用同一 WebContext，
//! 因此本设置对两者同时生效。

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
/// 供 WebView2 代理注入与 PTY 终端子进程环境注入共用。
pub fn read_proxy_settings() -> (String, String) {
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

/// Linux（WebKitGTK）代理注入：对已创建的 webview 会话设置网络代理。
///
/// 时机：必须在**页面加载之前**调用（Tauri 的 WebContext 由内部创建、无外部钩子，
/// 只能取到 webview 后经 `webview.context()` → `website_data_manager()` 设置）。
/// 本项目的调用点在 main webview 创建后立即执行（见 lib.rs setup 早期）。
/// WebKitGTK 的代理是会话级设置、进程内生效——改设置需重启应用（同 Windows 语义）。
///
/// - kv 有代理 → `Custom` + 每 scheme 代理 URI，no-proxy 规则映射 `ignore_hosts`
/// - kv 为空 → `NoProxy`（显式直连，不跟随系统环境代理/GSettings）
///
/// 需跨线程投递到 GTK 主线程执行（WebKitGTK 断言）。
#[cfg(target_os = "linux")]
pub fn apply_webkit_proxy_settings(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(webview) = app.get_webview_window("main") else {
        eprintln!("apply webkit proxy: main webview not found");
        return;
    };
    let (proxy, no_proxy) = read_proxy_settings();
    let proxy_trimmed = proxy.trim().to_string();
    if let Err(e) = webview.with_webview(move |platform| {
        use webkit2gtk::{
            NetworkProxyMode, NetworkProxySettings, WebContextExt, WebViewExt,
            WebsiteDataManagerExt,
        };
        let wk = platform.inner();
        let Some(context) = wk.context() else {
            eprintln!("apply webkit proxy: webview context unavailable");
            return;
        };
        let Some(data_manager) = context.website_data_manager() else {
            eprintln!("apply webkit proxy: website data manager unavailable");
            return;
        };
        if proxy_trimmed.is_empty() {
            data_manager.set_network_proxy_settings(NetworkProxyMode::NoProxy, None);
            return;
        }
        let ignore_hosts: Vec<&str> = no_proxy
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        let mut settings = NetworkProxySettings::new(Some(&proxy_trimmed), &ignore_hosts);
        for scheme in ["http", "https"] {
            settings.add_proxy_for_scheme(scheme, &proxy_trimmed);
        }
        data_manager.set_network_proxy_settings(NetworkProxyMode::Custom, Some(&mut settings));
    }) {
        eprintln!("apply webkit proxy: dispatch failed: {e}");
    }
}

/// 统一为 reqwest 目标请求 URL 构建带代理配置的客户端。
/// - 若未配置代理或目标 URL 命中 no-proxy 白名单，显式禁用一切代理（no_proxy）；
/// - 若配置了代理且未命中白名单，强制挂载代理；代理格式非法时如实报错抛出。
pub fn build_proxied_reqwest_client(
    for_url: &str,
    connect_timeout: Option<std::time::Duration>,
    total_timeout: Option<std::time::Duration>,
) -> Result<reqwest::Client, String> {
    let (proxy_url, _no_proxy) = read_proxy_settings();
    let proxy_trimmed = proxy_url.trim();
    let mut builder = reqwest::Client::builder();

    if let Some(ct) = connect_timeout {
        builder = builder.connect_timeout(ct);
    }
    if let Some(tt) = total_timeout {
        builder = builder.timeout(tt);
    }

    let bypass = crate::web_tools::url_bypasses_proxy(for_url);
    if proxy_trimmed.is_empty() || bypass {
        builder = builder.no_proxy();
    } else {
        let proxy = reqwest::Proxy::all(proxy_trimmed)
            .map_err(|e| format!("代理配置无效（kv {KV_WEB_PROXY} = {proxy_trimmed}）: {e}"))?;
        builder = builder.proxy(proxy);
    }

    builder.build().map_err(|e| format!("构建 HTTP 客户端失败: {e}"))
}

/// 统一为 ureq 目标请求 URL 构建带代理配置的 Agent。
/// 目标命中 no-proxy 白名单时直连，否则走代理配置；错误如实上抛。
pub fn build_proxied_ureq_agent(
    for_url: &str,
    connect_timeout: Option<std::time::Duration>,
    total_timeout: Option<std::time::Duration>,
    user_agent: Option<&str>,
) -> Result<ureq::Agent, String> {
    let proxy = crate::web_tools::resolve_proxy_for_url(for_url)?;
    let mut config = ureq::Agent::config_builder().http_status_as_error(false);

    if let Some(ct) = connect_timeout {
        config = config.timeout_connect(Some(ct));
    }
    if let Some(tt) = total_timeout {
        config = config.timeout_global(Some(tt));
    }
    if let Some(ua) = user_agent {
        config = config.user_agent(ua);
    }
    if let Some(p) = proxy {
        config = config.proxy(Some(p));
    }

    Ok(config.build().into())
}
