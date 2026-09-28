//! Hub 页面出网通道（Skills 商店 / MCP Registry 共用）。
//!
//! WebView 内直接 fetch 公网 API 会受 CORS/CSP 约束；LiveAgent 桌面端把
//! 这类请求经本地网关代理出网。这里对齐该语义：前端统一走本命令，
//! 由 Rust 侧 ureq（rustls，无 openssl 依赖）直连。

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubFetchArgs {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    /// 超时毫秒，缺省 30s
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubFetchResponse {
    pub status: u16,
    pub body: String,
}

/// 通用 JSON/文本 HTTP 请求（错误如实上抛，绝不静默降级）。
#[tauri::command]
pub async fn hub_fetch_json(args: HubFetchArgs) -> Result<HubFetchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let timeout = Duration::from_millis(args.timeout_ms.unwrap_or(30_000).clamp(1_000, 120_000));
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            // 非 2xx 不在 Rust 层抛错：状态码+响应体原样透传给前端（对齐 LA hubFetch
            // 返回真实 Response 的契约，前端 fetchJson 自行格式化 status+body 错误）
            .http_status_as_error(false)
            .build()
            .into();
        let method = args.method.to_uppercase();
        // ureq 3 的类型态 API：GET/HEAD（WithoutBody，只有 call）与
        // POST/PUT/DELETE（WithBody，只有 send）是不同类型，用两个宏分开处理。
        macro_rules! send_no_body {
            ($req:expr) => {{
                let mut r = $req;
                for (k, v) in &args.headers {
                    r = r.header(k.as_str(), v.as_str());
                }
                r.call()
            }};
        }
        macro_rules! send_with_body {
            ($req:expr) => {{
                let mut r = $req;
                for (k, v) in &args.headers {
                    r = r.header(k.as_str(), v.as_str());
                }
                match args.body.as_deref() {
                    Some(b) => r.header("Content-Type", "application/json").send(b.as_bytes()),
                    None => return Err(format!("hub_fetch_json: {method} 需要 body")),
                }
            }};
        }
        let mut resp = match method.as_str() {
            "GET" => send_no_body!(agent.get(&args.url)),
            "HEAD" => send_no_body!(agent.head(&args.url)),
            "POST" => send_with_body!(agent.post(&args.url)),
            "PUT" => send_with_body!(agent.put(&args.url)),
            "DELETE" => send_no_body!(agent.delete(&args.url)),
            other => return Err(format!("hub_fetch_json: 不支持的 HTTP 方法 {other}")),
        }
        .map_err(|e| format!("hub_fetch_json: {e}"))?;
        let status = resp.status().as_u16();
        let body = resp
            .body_mut()
            .read_to_string()
            .map_err(|e| format!("hub_fetch_json: 读取响应失败: {e}"))?;
        Ok(HubFetchResponse { status, body })
    })
    .await
    .map_err(|e| e.to_string())?
}
