//! llm_proxy —— LLM 流式请求的本地反向代理（LiveAgent services/proxy.rs 同款架构）。
//!
//! 为什么（2026-10-05，用户实测 GonkaRouter 流式经常半途无声截断，LiveAgent 同端点
//! 却完整）：tauri-plugin-http 的流要经 webview IPC 逐 chunk 搬运（每个 chunk 一次
//! `fetch_read_body` 往返），高吞吐/长流下该中继不可靠；且 reqwest 会静默继承系统
//! 环境变量代理。本模块在 127.0.0.1 上起一个 axum 反代：SDK 的 fetch 被改写到
//! `http://127.0.0.1:{port}/proxy`（上游真实地址经 `x-reinagent-upstream-url` 头
//! 下发），Rust 侧 reqwest 直连上游并把响应**流式**回传——webview 与上游之间没有
//! IPC 数据面，CORS 由本服务以 ACAO 头应答（webview 侧只是一次跨源 localhost 请求）。
//!
//! 安全：token（uuid，每次启动随机）鉴权；仅绑定 127.0.0.1。
//! 代理：每个请求按 kv `reinagent-web-proxy` / `reinagent-web-proxy-no-proxy`
//! 解析出网方式（与 proxiedFetch / web_tools 语义一致），reqwest 显式
//! `.no_proxy()` 或 `Proxy::all(...)`，环境变量代理永不静默接管。
//! 错误全部如实上抛（No-Fallback 铁律）。

use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::Response,
    routing::any,
    Router,
};
use serde::Serialize;
use std::{
    io::ErrorKind,
    net::{Ipv4Addr, TcpListener},
    sync::OnceLock,
    time::Duration,
};
use tokio::net::TcpListener as TokioTcpListener;

const TOKEN_HEADER: &str = "x-reinagent-token";
const UPSTREAM_URL_HEADER: &str = "x-reinagent-upstream-url";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

static PROXY_INFO: OnceLock<LlmProxyInfo> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProxyInfo {
    /// 本地反代基地址，如 `http://127.0.0.1:41235`
    pub base_url: String,
    pub token: String,
}

/// 供前端查询反代地址与 token（启动后懒取一次并缓存）。
#[tauri::command]
pub fn llm_proxy_info() -> Result<LlmProxyInfo, String> {
    PROXY_INFO.get().cloned().ok_or_else(|| {
        "LLM 本地反代尚未启动（应用初始化异常）".to_string()
    })
}

/// 启动本地流式反代（绑定 127.0.0.1:0，端口随机）。失败如实返回，调用方打日志。
pub fn start() -> Result<(), String> {
    // reqwest 0.13 的 rustls 需要进程级 crypto provider（幂等安装）
    let _ = rustls::crypto::ring::default_provider().install_default();

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("LLM 反代绑定端口失败: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("LLM 反代设置 nonblocking 失败: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("LLM 反代读取监听地址失败: {e}"))?;

    let info = LlmProxyInfo {
        base_url: format!("http://{addr}"),
        token: uuid::Uuid::new_v4().to_string(),
    };

    let app = Router::new().route("/proxy", any(handle_proxy));

    // ⚠ from_std/axum::serve 必须在 tokio 运行时上下文内执行：setup 钩子跑在主线程
    // （无 tokio 上下文，直接 from_std 会 panic）。整体放进 async_runtime 的异步块——
    // tauri 全局运行时从任意线程 spawn 均可用，任务内部自带运行时上下文。
    tauri::async_runtime::spawn(async move {
        let listener = match TokioTcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("failed to convert llm proxy listener: {err}");
                return;
            }
        };
        if let Err(err) = axum::serve(listener, app).await {
            eprintln!("LLM 本地反代异常退出: {err}");
        }
    });

    PROXY_INFO
        .set(info)
        .map_err(|_| "LLM 反代信息重复初始化".to_string())?;
    Ok(())
}

async fn handle_proxy(
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // ---- CORS 预检：SDK 请求带 Authorization 等头，浏览器会先发 OPTIONS ----
    if method == Method::OPTIONS {
        return preflight_response(&headers);
    }

    // ---- token 鉴权（防止本机其他进程滥用该代理出网）----
    let expected_token = PROXY_INFO.get().map(|i| i.token.clone()).unwrap_or_default();
    let token_ok = headers
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v == expected_token)
        .unwrap_or(false);
    if !token_ok {
        return error_response(StatusCode::FORBIDDEN, "invalid proxy token", &headers);
    }

    // ---- 上游地址 ----
    let upstream_url = match headers
        .get(UPSTREAM_URL_HEADER)
        .and_then(|v| v.to_str().ok())
    {
        Some(u) => u.to_string(),
        None => {
            return error_response(
                StatusCode::BAD_REQUEST,
                &format!("missing header {UPSTREAM_URL_HEADER}"),
                &headers,
            )
        }
    };
    if !upstream_url.starts_with("http://") && !upstream_url.starts_with("https://") {
        return error_response(
            StatusCode::BAD_REQUEST,
            &format!("unsupported upstream scheme: {upstream_url}"),
            &headers,
        );
    }

    // ---- 上游客户端：按 kv 代理设置解析出网方式（每请求构建，设置即时生效）----
    let client = match build_upstream_client(&upstream_url) {
        Ok(c) => c,
        Err(e) => return error_response(StatusCode::BAD_GATEWAY, &e, &headers),
    };

    // ---- 转发请求（剥离本代专属头与 hop-by-hop 头）----
    let mut req = client.request(method.clone(), &upstream_url);
    for (name, value) in headers.iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if lower.starts_with("x-reinagent-")
            || lower == "host"
            || lower == "content-length"
            || lower == "connection"
            || lower == "origin"
            || lower == "referer"
            || lower == "accept-encoding"
        {
            continue;
        }
        req = req.header(name.clone(), value.clone());
    }
    if !body.is_empty() {
        req = req.body(body);
    }

    let upstream = match req.send().await {
        Ok(resp) => resp,
        Err(err) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                &format!("LLM 反代转发上游失败: {err}"),
                &headers,
            )
        }
    };

    // ---- 流式回传：bytes_stream → Body，不缓冲不落盘，SSE 直通 ----
    let status = upstream.status();
    let mut builder = Response::builder().status(status);
    for (name, value) in upstream.headers().iter() {
        let lower = name.as_str().to_ascii_lowercase();
        // hop-by-hop 与本代逐转头不上传
        if lower == "connection"
            || lower == "keep-alive"
            || lower == "transfer-encoding"
            || lower == "content-length"
            || lower.starts_with("access-control-")
        {
            continue;
        }
        if let Ok(v) = HeaderValue::from_bytes(value.as_bytes()) {
            builder = builder.header(name.clone(), v);
        }
    }
    let body = Body::from_stream(upstream.bytes_stream());
    let mut response = builder.body(body).unwrap_or_else(|err| {
        error_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("LLM 反代响应构建失败: {err}"), &headers)
    });
    append_cors(&mut response, &headers);
    response
}

/// 按 kv 代理设置构建上游客户端：
/// - `reinagent-web-proxy` 非空且目标未命中 no-proxy 规则 → `Proxy::all(kv)`
/// - 其余（kv 为空 / 命中 no-proxy）→ `.no_proxy()` 显式直连（压制环境变量代理）
fn build_upstream_client(upstream_url: &str) -> Result<reqwest::Client, String> {
    let (proxy_url, no_proxy) = read_kv_proxy_settings();

    let mut builder = reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT);

    let use_proxy = !proxy_url.is_empty() && !matches_no_proxy(upstream_url, &no_proxy);
    if use_proxy {
        let mut proxy = reqwest::Proxy::all(proxy_url.as_str())
            .map_err(|e| format!("代理配置无效（kv reinagent-web-proxy = {proxy_url}）: {e}"))?;
        if !no_proxy.is_empty() {
            proxy = proxy.no_proxy(reqwest::NoProxy::from_string(&no_proxy));
        }
        builder = builder.proxy(proxy);
    } else {
        // 「留空直连」语义：显式禁用一切代理（含环境变量），绝不静默接管
        builder = builder.no_proxy();
    }

    builder.build().map_err(|e| format!("LLM 反代上游客户端构建失败: {e}"))
}

/// 读 kv 代理设置（与 proxiedFetch 同两把键）。
fn read_kv_proxy_settings() -> (String, String) {
    let read = |key: &str| -> String {
        crate::conversation_store::db_conn()
            .ok()
            .and_then(|conn| {
                conn.query_row(
                    "SELECT value FROM kv WHERE key = ?1",
                    [key],
                    |row| row.get::<_, String>(0),
                )
                .ok()
            })
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    (read("reinagent-web-proxy"), read("reinagent-web-proxy-no-proxy"))
}

/// no-proxy 规则命中判定（与前端 matchesNoProxy 同语义：通配包含 + 后缀匹配）。
fn matches_no_proxy(url: &str, no_proxy: &str) -> bool {
    let host = match reqwest::Url::parse(url) {
        Ok(u) => u.host_str().unwrap_or_default().to_ascii_lowercase(),
        Err(_) => return false,
    };
    no_proxy
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase().replace('.', "").replace('*', ""))
        .filter(|s| !s.is_empty())
        .any(|rule| host.contains(&rule))
}

fn preflight_response(request_headers: &HeaderMap) -> Response {
    let mut response = Response::new(Body::empty());
    append_cors(&mut response, request_headers);
    *response.status_mut() = StatusCode::NO_CONTENT;
    response
}

fn append_cors(response: &mut Response, request_headers: &HeaderMap) {
    let allow_headers = request_headers
        .get("access-control-request-headers")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| "*".to_string());
    let h = response.headers_mut();
    h.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    h.insert("access-control-allow-methods", HeaderValue::from_static("GET,POST,PUT,PATCH,DELETE,OPTIONS"));
    if let Ok(v) = HeaderValue::from_str(&allow_headers) {
        h.insert("access-control-allow-headers", v);
    }
    h.insert("access-control-expose-headers", HeaderValue::from_static("*"));
    h.insert("vary", HeaderValue::from_static("Origin"));
}

fn error_response(status: StatusCode, message: &str, request_headers: &HeaderMap) -> Response {
    let mut response = Response::builder()
        .status(status)
        .body(Body::from(message.to_string()))
        .unwrap_or_else(|_| Response::new(Body::from(message.to_string())));
    append_cors(&mut response, request_headers);
    response
}

// 保留 ErrorKind 引用（未来细分类错误用），避免 unused import 告警
#[allow(unused)]
fn _error_kind_usage(_: ErrorKind) {}
