//! 远程访问（局域网 Web 型）——手机浏览器直连桌面端内置 Web 服务。
//!
//! 架构对齐 ZCode `web-remote-replayable` 纪律 + LiveAgent 审批回环：
//! - 桌面端 tokio/axum 监听 0.0.0.0:端口（默认关，设置开启才启动）；
//! - 所有路由（含静态页）必须带 token（?token= / Bearer / Cookie 三选一），
//!   token 只存 SHA-256（PI 纪律：明文仅设置页展示）；
//! - 手机能力白名单五个 op：list_tasks / subscribe / send / approve / stop——
//!   桌面为唯一权威，会话运行时在 webview（conversationPool），
//!   Rust 与 webview 之间用 Tauri 事件 + 专用命令桥接。
//!
//! 安全底线：连续鉴权失败 5 次 → 该 IP 拉黑 5 分钟。

use futures_util::{SinkExt, StreamExt};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

// ---------------- 状态 ----------------

pub struct RemoteServerState {
    enabled: AtomicBool,
    port: AtomicU32,
    /// SHA-256(token) hex（明文不存 Rust 侧；设置页展示走独立 kv 读回）
    token_hash: std::sync::Mutex<String>,
    handle: std::sync::Mutex<Option<tauri::AppHandle>>,
    /// 客户端向 webview 广播用的 app 句柄快照
    shutdown_tx: std::sync::Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    /// 鉴权失败拉黑表：ip → 拉黑到期时刻
    blacklist: std::sync::Mutex<HashMap<String, Instant>>,
    fail_counts: std::sync::Mutex<HashMap<String, u32>>,
    connected_clients: AtomicU32,
}

impl RemoteServerState {
    fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            port: AtomicU32::new(7777),
            token_hash: std::sync::Mutex::new(String::new()),
            handle: std::sync::Mutex::new(None),
            shutdown_tx: std::sync::Mutex::new(None),
            blacklist: std::sync::Mutex::new(HashMap::new()),
            fail_counts: std::sync::Mutex::new(HashMap::new()),
            connected_clients: AtomicU32::new(0),
        }
    }
}

fn state() -> Arc<RemoteServerState> {
    static STATE: OnceLock<Arc<RemoteServerState>> = OnceLock::new();
    STATE.get_or_init(|| Arc::new(RemoteServerState::new())).clone()
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex_encode(&hasher.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------- 持久化（kv 表，复用 conversation_store 的连接） ----------------

const KV_ENABLED: &str = "remote-server-enabled";
const KV_PORT: &str = "remote-server-port";
const KV_TOKEN: &str = "remote-server-token"; // 明文（仅本机设置页读）
const KV_TOKEN_HASH: &str = "remote-server-token-hash";
const KV_NETWORK_MODE: &str = "remote-server-network-mode"; // "lan" | "cloudflare" | "custom"
const KV_CUSTOM_URL: &str = "remote-server-custom-url";

fn kv_get(key: &str) -> Option<String> {
    let Ok(conn) = crate::conversation_store::db_conn() else { return None; };
    conn.query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| row.get::<_, String>(0))
        .ok()
}

fn kv_set(key: &str, value: &str) {
    let Ok(conn) = crate::conversation_store::db_conn() else { return; };
    let _ = conn.execute(
        "INSERT INTO kv(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    );
}

// ---------------- 鉴权 ----------------

const MAX_FAILURES: u32 = 5;
const BLACKLIST_MS: u64 = 5 * 60 * 1000;

/// 从请求头或 socket 地址提取真实客户端 IP（优先 CF-Connecting-IP 与 X-Forwarded-For）
fn resolve_client_ip(headers: &HeaderMap, connect_addr: &SocketAddr) -> String {
    if let Some(cf_ip) = headers.get("cf-connecting-ip").and_then(|v| v.to_str().ok()) {
        let ip = cf_ip.trim();
        if !ip.is_empty() {
            return ip.to_string();
        }
    }
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff.split(',').next() {
            let ip = first.trim();
            if !ip.is_empty() {
                return ip.to_string();
            }
        }
    }
    connect_addr.ip().to_string()
}

fn is_blacklisted(ip: &str) -> bool {
    let st = state();
    let mut blacklist = st.blacklist.lock().expect("blacklist lock");
    if let Some(until) = blacklist.get(ip) {
        if Instant::now() < *until {
            return true;
        }
        blacklist.remove(ip);
    }
    false
}

fn record_auth_failure(ip: &str) -> bool {
    // 保护本地回环与本地隧道自身绝对不被加入黑名单
    if ip == "127.0.0.1" || ip == "::1" || ip == "localhost" {
        return false;
    }
    let st = state();
    let mut counts = st.fail_counts.lock().expect("fail counts lock");
    let count = counts.entry(ip.to_string()).or_insert(0);
    *count += 1;
    if *count >= MAX_FAILURES {
        let mut blacklist = st.blacklist.lock().expect("blacklist lock");
        blacklist.insert(ip.to_string(), Instant::now() + Duration::from_millis(BLACKLIST_MS));
        counts.remove(ip);
        true
    } else {
        false
    }
}

fn clear_failures(ip: &str) {
    state().fail_counts.lock().expect("fail counts lock").remove(ip);
}

/// 从 query / Authorization 头 / Cookie 三处提取 token。
fn extract_token(query_token: Option<&str>, headers: &HeaderMap) -> Option<String> {
    if let Some(t) = query_token.filter(|t| !t.trim().is_empty()) {
        return Some(t.trim().to_string());
    }
    if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            if !token.trim().is_empty() {
                return Some(token.trim().to_string());
            }
        }
    }
    if let Some(cookie) = headers.get("cookie").and_then(|v| v.to_str().ok()) {
        for pair in cookie.split(';') {
            let pair = pair.trim();
            if let Some(value) = pair.strip_prefix("reinagent_remote_token=") {
                if !value.trim().is_empty() {
                    return Some(value.trim().to_string());
                }
            }
        }
    }
    None
}

/// 校验 token。返回 Ok(Some(token)) = 通过且 token 来自 query（需种 Cookie 以支持刷新）；
/// Ok(None) = 通过（Bearer/Cookie）；Err = 拒绝（触发拉黑逻辑）。
fn verify_token(
    query_token: Option<&str>,
    headers: &HeaderMap,
    ip: &str,
) -> Result<Option<String>, StatusCode> {
    // 持有合法 token 的请求不受拉黑影响（拉黑只针对无/错凭据的爆破尝试）：
    // 先验 token，失败才走拉黑计数。
    let Some(token) = extract_token(query_token, headers) else {
        if is_blacklisted(ip) {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let blocked = record_auth_failure(ip);
        return Err(if blocked { StatusCode::TOO_MANY_REQUESTS } else { StatusCode::UNAUTHORIZED });
    };
    let expected = state().token_hash.lock().expect("token hash lock").clone();
    if expected.is_empty() || sha256_hex(&token) != expected {
        if is_blacklisted(ip) {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let blocked = record_auth_failure(ip);
        return Err(if blocked { StatusCode::TOO_MANY_REQUESTS } else { StatusCode::UNAUTHORIZED });
    }
    clear_failures(ip);
    // 合法 token 顺带解除该 IP 的拉黑（token 本身已是充分凭据）
    state().blacklist.lock().expect("blacklist lock").remove(ip);
    let via_query = query_token.map(|t| !t.trim().is_empty()).unwrap_or(false);
    Ok(via_query.then(|| token))
}

// ---------------- 手机前端（Vite 构建产物编译期内嵌，见 vite.remote.config.ts） ----------------

static REMOTE_APP: Dir = include_dir!("$CARGO_MANIFEST_DIR/remote_assets/app");

fn mime_for_path(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 从内嵌目录取文件；找不到时回退 index.html（前端无路由，仅为健壮性兜底）。
/// 根路径显式 text/html——mime_for_path 对无扩展名路径会落到 octet-stream，
/// WebView2 把 octet-stream 顶层导航当下载拒绝（ERR_ABORTED + isDownload）。
fn remote_app_asset(path: &str) -> Option<(&'static [u8], &'static str)> {
    let trimmed = path.trim_start_matches('/');
    let is_root = trimmed.is_empty() || trimmed == "index.html";
    let file = REMOTE_APP
        .get_file(trimmed)
        .or_else(|| REMOTE_APP.get_file("index.html"))?;
    let mime = if is_root { "text/html; charset=utf-8" } else { mime_for_path(trimmed) };
    Some((file.contents(), mime))
}

#[derive(Deserialize)]
struct TokenQuery {
    #[serde(default)]
    token: Option<String>,
}

async fn page_handler(
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Result<impl IntoResponse, StatusCode> {
    serve_remote_asset("", Query(query), headers, addr).await
}

async fn remote_asset_handler(
    // axum 通配符 {*path} 只捕获 /assets/ 之后的余下段 —— 内嵌查找需还原 assets/ 前缀
    axum::extract::Path(path): axum::extract::Path<String>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Result<impl IntoResponse, StatusCode> {
    serve_remote_asset(&format!("assets/{path}"), Query(query), headers, addr).await
}

async fn serve_remote_asset(
    path: &str,
    query: Query<TokenQuery>,
    headers: HeaderMap,
    addr: SocketAddr,
) -> Result<impl IntoResponse, StatusCode> {
    let ip = resolve_client_ip(&headers, &addr);
    // 通过 query token 鉴权时种 HttpOnly Cookie：页面 replaceState 清掉 URL 里的
    // token 后，刷新仍能凭 Cookie 通过（对齐 ZCode hasValidLiteToken 语义）。
    let via_query_token = verify_token(query.token.as_deref(), &headers, &ip)?;
    let (body, mime) =
        remote_app_asset(path).ok_or(StatusCode::NOT_FOUND)?;
    let mut response = ([("content-type", mime)], Vec::<u8>::from(body)).into_response();
    if let Some(token) = via_query_token {
        response.headers_mut().append(
            axum::http::header::SET_COOKIE,
            axum::http::HeaderValue::from_str(&format!(
                "reinagent_remote_token={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000"
            ))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        );
    }
    Ok(response)
}

// ---------------- WS 协议 ----------------

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ServerMessage {
    Hello {
        ok: bool,
        /// 服务端时间戳（手机端时钟差校准用）
        server_time: u64,
    },
    /// 通用请求应答（switch_task / start_draft / list_models 等 reqId 型 op）
    Result {
        req_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        payload: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// 任务/工作区快照（ZCode WebRemoteControlWorkspaceListResult 同形；主动推送 + 拉取应答）
    WorkspaceList { payload: Value },
    State {
        task_id: String,
        revision: u64,
        /// 序列化时间线行（serializeEntry 同形）+ queuedMessages + pendingApproval
        messages: Value,
        running: bool,
        /// 排队中的引导消息（流式中 send 入队）
        #[serde(skip_serializing_if = "Option::is_none")]
        queued_messages: Option<Value>,
        /// 审批/提问/计划挂起（args.kind 区分；与桌面 ApprovalCard 同源）
        #[serde(skip_serializing_if = "Option::is_none")]
        pending_approval: Option<Value>,
        /// 上下文容量快照（桌面 buildContextUsageData 可序列化子集；仅活动任务）
        #[serde(skip_serializing_if = "Option::is_none")]
        context_usage: Option<Value>,
    },
    ApprovalPending {
        task_id: String,
        tool_name: String,
        args: Value,
    },
    /// 桌面活动任务/工作区变化同步（手机跟随桌面切换）
    DesktopState {
        active_task_id: Option<String>,
        active_workspace_key: Option<String>,
    },
    Accepted {
        req_id: String,
    },
    Error {
        req_id: String,
        message: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ClientMessage {
    #[serde(rename = "hello")]
    Hello {},
    #[serde(rename = "list_tasks")]
    ListTasks { req_id: String },
    #[serde(rename = "list_workspaces")]
    ListWorkspaces { req_id: String },
    #[serde(rename = "subscribe")]
    Subscribe { req_id: String, task_id: String },
    #[serde(rename = "unsubscribe")]
    Unsubscribe { req_id: String, task_id: String },
    #[serde(rename = "send")]
    Send {
        req_id: String,
        /// null = 桌面草稿态发送（提升为首条消息建任务）
        task_id: Option<String>,
        text: String,
        /// 远程上传的附件（upload 端点返回的路径）
        #[serde(default)]
        attachments: Vec<Value>,
    },
    #[serde(rename = "approve")]
    Approve { req_id: String, task_id: String, decision: Value },
    #[serde(rename = "stop")]
    Stop { req_id: String, task_id: String },
    // ---- ZCode MobileShell Switcher API 同款操作（generic request 应答） ----
    #[serde(rename = "switch_task")]
    SwitchTask { req_id: String, task_id: String },
    #[serde(rename = "start_draft")]
    StartDraft { req_id: String, workspace_key: String },
    #[serde(rename = "mark_task_read")]
    MarkTaskRead { req_id: String, task_id: String },
    #[serde(rename = "update_mobile_view_state")]
    UpdateMobileViewState { req_id: String, workspace_key: String, task_id: Option<String> },
    #[serde(rename = "remove_queued")]
    RemoveQueued { req_id: String, task_id: String, index: u32 },
    #[serde(rename = "list_models")]
    ListModels { req_id: String },
    #[serde(rename = "set_model")]
    SetModel { req_id: String, task_id: Option<String>, provider_id: String, model_id: String },
    #[serde(rename = "get_task_options")]
    GetTaskOptions { req_id: String, task_id: Option<String> },
    #[serde(rename = "set_approval_mode")]
    SetApprovalMode { req_id: String, task_id: Option<String>, mode: String },
    #[serde(rename = "set_thinking_level")]
    SetThinkingLevel { req_id: String, task_id: Option<String>, level: String },
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(app): State<AppHandle>,
) -> Result<impl IntoResponse, StatusCode> {
    let ip = resolve_client_ip(&headers, &addr);
    verify_token(query.token.as_deref(), &headers, &ip)?;
    Ok(ws.on_upgrade(move |socket| ws_session(socket, app)))
}

/// 每客户端会话：订阅的任务集合 + 出站通道。
struct WsClient {
    app: AppHandle,
    out_tx: tokio::sync::mpsc::UnboundedSender<Message>,
    subscribed: std::collections::HashSet<String>,
}

impl WsClient {
    fn send(&self, msg: ServerMessage) {
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = self.out_tx.send(Message::Text(json.into()));
        }
    }
}

async fn ws_session(socket: WebSocket, app: AppHandle) {
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let client = Arc::new(tokio::sync::Mutex::new(WsClient {
        app: app.clone(),
        out_tx,
        subscribed: std::collections::HashSet::new(),
    }));
    state().connected_clients.fetch_add(1, Ordering::Relaxed);
    emit_status(&app);

    let (mut sender, mut receiver) = socket.split();

    // 出站泵：桥接事件（快照/状态/审批）经 BroadcastBus 广播给所有客户端，
    // 这里只负责把本客户端的 out_rx 泵回 socket。
    let out_pump = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    // 订阅桥接广播（桌面 webview 推来的状态/审批事件）
    let mut bridge_rx = bridge_bus().subscribe();
    let client_for_bridge = client.clone();
    let bridge_task = tokio::spawn(async move {
        loop {
            match bridge_rx.recv().await {
                Ok(event) => {
                    let guard = client_for_bridge.lock().await;
                    match event {
                        BridgeEvent::State { task_id, revision, messages, running, queued_messages, pending_approval, context_usage } => {
                            if guard.subscribed.contains(&task_id) {
                                guard.send(ServerMessage::State { task_id, revision, messages, running, queued_messages, pending_approval, context_usage });
                            }
                        }
                        BridgeEvent::ApprovalPending { task_id, tool_name, args } => {
                            if guard.subscribed.contains(&task_id) {
                                guard.send(ServerMessage::ApprovalPending { task_id, tool_name, args });
                            }
                        }
                        BridgeEvent::WorkspaceList { payload } => {
                            guard.send(ServerMessage::WorkspaceList { payload });
                        }
                        BridgeEvent::DesktopState { active_task_id, active_workspace_key } => {
                            guard.send(ServerMessage::DesktopState { active_task_id, active_workspace_key });
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });

    // 入站消息处理
    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(text) => {
                if let Err(err) = handle_client_text(&client, &text).await {
                    // 协议错误：回 Error 帧后继续（不致命）
                    let _ = client.lock().await.out_tx.send(
                        Message::Text(
                            serde_json::to_string(&ServerMessage::Error {
                                req_id: String::new(),
                                message: err,
                            })
                            .unwrap_or_default()
                            .into(),
                        ),
                    );
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    out_pump.abort();
    bridge_task.abort();
    state().connected_clients.fetch_sub(1, Ordering::Relaxed);
    emit_status(&app);
}

async fn handle_client_text(client: &Arc<tokio::sync::Mutex<WsClient>>, text: &str) -> Result<(), String> {
    let msg: ClientMessage =
        serde_json::from_str(text).map_err(|e| format!("协议解析失败: {e}"))?;
    let mut guard = client.lock().await;
    match msg {
        ClientMessage::Hello {} => {
            guard.send(ServerMessage::Hello { ok: true, server_time: now_ms() });
        }
        ClientMessage::ListTasks { req_id } | ClientMessage::ListWorkspaces { req_id } => {
            {
            let app = guard.app.clone();
            guard.send(ServerMessage::Accepted { req_id: req_id.clone() });
            drop(guard);
            request_over_ws(client.clone(), app, req_id, "list_workspaces", serde_json::json!({})).await;
        }
        }
        ClientMessage::Subscribe { req_id, task_id } => {
            guard.subscribed.insert(task_id.clone());
            guard.send(ServerMessage::Accepted { req_id });
            // 立即推一次当前状态
            let app = guard.app.clone();
            drop(guard);
            if let Some(state) = request_task_state_from_webview(&app, &task_id).await {
                // 空帧（池刚创建、水合未完成）不广播——保留手机端「加载中」态，
                // 水合完成后的 notify 会推真帧（空会话与水合空窗此时无法区分，宁可多等）。
                let is_empty = state.messages.as_array().map(|a| a.is_empty()).unwrap_or(false);
                if !is_empty {
                    let _ = bridge_bus().send(BridgeEvent::State {
                        task_id,
                        revision: state.revision,
                        messages: state.messages,
                        running: state.running,
                        queued_messages: state.queued_messages,
                        pending_approval: state.pending_approval,
                        context_usage: state.context_usage,
                    });
                }
            }
        }
        ClientMessage::Unsubscribe { req_id, task_id } => {
            guard.subscribed.remove(&task_id);
            guard.send(ServerMessage::Accepted { req_id });
        }
        ClientMessage::Send { req_id, task_id, text, attachments } => {
            guard.send(ServerMessage::Accepted { req_id });
            let app = guard.app.clone();
            drop(guard);
            let _ = app.emit(
                "remote-bridge:send",
                serde_json::json!({ "taskId": task_id, "text": text, "attachments": attachments }),
            );
        }
        ClientMessage::Approve { req_id, task_id, decision } => {
            guard.send(ServerMessage::Accepted { req_id });
            let app = guard.app.clone();
            drop(guard);
            let _ = app.emit(
                "remote-bridge:resolve",
                serde_json::json!({ "taskId": task_id, "decision": decision }),
            );
        }
        ClientMessage::Stop { req_id, task_id } => {
            guard.send(ServerMessage::Accepted { req_id });
            let app = guard.app.clone();
            drop(guard);
            let _ = app.emit("remote-bridge:stop", serde_json::json!({ "taskId": task_id }));
        }
        // ---- reqId 型操作统一走 webview 请求等待器（应答帧 Result） ----
        ClientMessage::SwitchTask { req_id, task_id } => {
            {
            let app = guard.app.clone();
            guard.send(ServerMessage::Accepted { req_id: req_id.clone() });
            drop(guard);
            request_over_ws(client.clone(), app, req_id, "switch_task", serde_json::json!({ "taskId": task_id })).await;
        }
        }
        ClientMessage::StartDraft { req_id, workspace_key } => {
            {
            let app = guard.app.clone();
            guard.send(ServerMessage::Accepted { req_id: req_id.clone() });
            drop(guard);
            request_over_ws(client.clone(), app, req_id, "start_draft", serde_json::json!({ "workspaceKey": workspace_key })).await;
        }
        }
        ClientMessage::MarkTaskRead { req_id, task_id } => {
            {
            let app = guard.app.clone();
            guard.send(ServerMessage::Accepted { req_id: req_id.clone() });
            drop(guard);
            request_over_ws(client.clone(), app, req_id, "mark_task_read", serde_json::json!({ "taskId": task_id })).await;
        }
        }
        ClientMessage::UpdateMobileViewState { req_id, workspace_key, task_id } => {
            {
            let app = guard.app.clone();
            guard.send(ServerMessage::Accepted { req_id: req_id.clone() });
            drop(guard);
            request_over_ws(client.clone(), app, req_id, "update_mobile_view_state", serde_json::json!({ "workspaceKey": workspace_key, "taskId": task_id })).await;
        }
        }
        ClientMessage::RemoveQueued { req_id, task_id, index } => {
            {
            let app = guard.app.clone();
            guard.send(ServerMessage::Accepted { req_id: req_id.clone() });
            drop(guard);
            request_over_ws(client.clone(), app, req_id, "remove_queued", serde_json::json!({ "taskId": task_id, "index": index })).await;
        }
        }
        ClientMessage::ListModels { req_id } => {
            {
            let app = guard.app.clone();
            guard.send(ServerMessage::Accepted { req_id: req_id.clone() });
            drop(guard);
            request_over_ws(client.clone(), app, req_id, "list_models", serde_json::json!({})).await;
        }
        }
        ClientMessage::SetModel { req_id, task_id, provider_id, model_id } => {
            {
            let app = guard.app.clone();
            guard.send(ServerMessage::Accepted { req_id: req_id.clone() });
            drop(guard);
            request_over_ws(client.clone(), app, req_id, "set_model", serde_json::json!({ "taskId": task_id, "providerId": provider_id, "modelId": model_id })).await;
        }
        }
        ClientMessage::GetTaskOptions { req_id, task_id } => {
            {
            let app = guard.app.clone();
            guard.send(ServerMessage::Accepted { req_id: req_id.clone() });
            drop(guard);
            request_over_ws(client.clone(), app, req_id, "get_task_options", serde_json::json!({ "taskId": task_id })).await;
        }
        }
        ClientMessage::SetApprovalMode { req_id, task_id, mode } => {
            {
            let app = guard.app.clone();
            guard.send(ServerMessage::Accepted { req_id: req_id.clone() });
            drop(guard);
            request_over_ws(client.clone(), app, req_id, "set_approval_mode", serde_json::json!({ "taskId": task_id, "mode": mode })).await;
        }
        }
        ClientMessage::SetThinkingLevel { req_id, task_id, level } => {
            {
            let app = guard.app.clone();
            guard.send(ServerMessage::Accepted { req_id: req_id.clone() });
            drop(guard);
            request_over_ws(client.clone(), app, req_id, "set_thinking_level", serde_json::json!({ "taskId": task_id, "level": level })).await;
        }
        }
    }
    Ok(())
}

/// reqId 型 op 的等待段（Accepted 已由调用方经守卫发出、守卫已放锁）：
/// **spawn 独立任务**等待 webview 应答（remote_bridge_answer_request 解析等待器）→ 短锁回 Result 帧。
/// 绝不在 handle_client_text 的处理循环内等待——同一连接上后续帧（subscribe/send/…）
/// 会被 15s 等待窗口串行阻塞（实测：hello 后 list_workspaces+list_models 各等应答，
/// 跟发的 subscribe 被堵到超时，手机页永远收不到任务状态）。
async fn request_over_ws(
    client: Arc<tokio::sync::Mutex<WsClient>>,
    app: AppHandle,
    req_id: String,
    kind: &str,
    payload: Value,
) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    request_waiters().lock().expect("request waiters lock").insert(req_id.clone(), tx);
    let _ = app.emit(
        "remote-bridge:request",
        serde_json::json!({ "reqId": req_id, "kind": kind, "payload": payload }),
    );
    tauri::async_runtime::spawn(async move {
        let outcome = match tokio::time::timeout(Duration::from_secs(15), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("webview dropped the request".to_string()),
            Err(_) => Err("webview request timed out".to_string()),
        };
        // 无论如何清理等待器（超时路径防泄漏）
        request_waiters().lock().expect("request waiters lock").remove(&req_id);
        let frame = match outcome {
            Ok(payload) => ServerMessage::Result { req_id, ok: true, payload: Some(payload), error: None },
            Err(error) => ServerMessage::Result { req_id, ok: false, payload: None, error: Some(error) },
        };
        guard_send(&client, frame).await;
    });
}

/// 短暂加锁发送一帧（不跨 await 持锁）。
async fn guard_send(client: &Arc<tokio::sync::Mutex<WsClient>>, msg: ServerMessage) {
    let guard = client.lock().await;
    guard.send(msg);
}

/// webview 应答通用请求（remoteBridge 调用）：解析对应连接上挂着的等待器。
#[tauri::command]
pub async fn remote_bridge_answer_request(
    req_id: String,
    ok: bool,
    payload: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let waiter = request_waiters().lock().expect("request waiters lock").remove(&req_id);
    if let Some(waiter) = waiter {
        let result = if ok {
            Ok(payload.unwrap_or(Value::Null))
        } else {
            Err(error.unwrap_or_else(|| "unknown error".to_string()))
        };
        let _ = waiter.send(result);
    }
    Ok(())
}

/// webview 推送工作区/任务快照（ZCode WorkspaceListResult 同形 JSON）。
#[tauri::command]
pub async fn remote_bridge_push_workspace_list(payload: Value) -> Result<(), String> {
    broadcast_workspace_list(&payload);
    Ok(())
}

fn broadcast_workspace_list(payload: &Value) {
    let _ = bridge_bus().send(BridgeEvent::WorkspaceList { payload: payload.clone() });
}

/// 桥接广播总线：webview 推来的状态/审批事件扇出给所有 WS 客户端。
#[derive(Clone, Debug)]
enum BridgeEvent {
    State {
        task_id: String,
        revision: u64,
        messages: Value,
        running: bool,
        queued_messages: Option<Value>,
        pending_approval: Option<Value>,
        context_usage: Option<Value>,
    },
    ApprovalPending { task_id: String, tool_name: String, args: Value },
    WorkspaceList { payload: Value },
    DesktopState { active_task_id: Option<String>, active_workspace_key: Option<String> },
}

static BRIDGE_BUS: OnceLock<tokio::sync::broadcast::Sender<BridgeEvent>> = OnceLock::new();

fn bridge_bus() -> &'static tokio::sync::broadcast::Sender<BridgeEvent> {
    BRIDGE_BUS.get_or_init(|| tokio::sync::broadcast::channel(64).0)
}

/// webview → Rust 状态推送（会话池订阅回调；含排队消息与挂起审批）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStateArgs {
    pub task_id: String,
    pub revision: u64,
    pub messages: Value,
    pub running: bool,
    #[serde(default)]
    pub queued_messages: Option<Value>,
    #[serde(default)]
    pub pending_approval: Option<Value>,
    #[serde(default)]
    pub context_usage: Option<Value>,
}

#[tauri::command]
pub async fn remote_bridge_state(args: BridgeStateArgs) -> Result<(), String> {
    let reply = TaskStateReply {
        revision: args.revision,
        messages: args.messages.clone(),
        running: args.running,
        queued_messages: args.queued_messages.clone(),
        pending_approval: args.pending_approval.clone(),
        context_usage: args.context_usage.clone(),
    };
    if let Some(waiter) = state_waiters().lock().expect("waiters lock").remove(&args.task_id) {
        let _ = waiter.send(reply);
    }
    let _ = bridge_bus().send(BridgeEvent::State {
        task_id: args.task_id,
        revision: args.revision,
        messages: args.messages,
        running: args.running,
        queued_messages: args.queued_messages,
        pending_approval: args.pending_approval,
        context_usage: args.context_usage,
    });
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeApprovalArgs {
    pub task_id: String,
    pub tool_name: String,
    pub args: Value,
}

#[tauri::command]
pub async fn remote_bridge_approval(args: BridgeApprovalArgs) -> Result<(), String> {
    let _ = bridge_bus().send(BridgeEvent::ApprovalPending {
        task_id: args.task_id,
        tool_name: args.tool_name,
        args: args.args,
    });
    Ok(())
}

/// webview 推送桌面活动任务/工作区变化（手机跟随）。
#[tauri::command]
pub async fn remote_bridge_push_desktop_state(
    active_task_id: Option<String>,
    active_workspace_key: Option<String>,
) -> Result<(), String> {
    let _ = bridge_bus().send(BridgeEvent::DesktopState {
        active_task_id,
        active_workspace_key,
    });
    Ok(())
}

async fn request_task_state_from_webview(app: &AppHandle, task_id: &str) -> Option<TaskStateReply> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state_waiters().lock().expect("state waiters lock").insert(task_id.to_string(), tx);
    let _ = app.emit("remote-bridge:need-state", serde_json::json!({ "taskId": task_id }));
    tokio::time::timeout(Duration::from_secs(5), rx).await.ok()?.ok()
}

#[derive(Debug)]
struct TaskStateReply {
    revision: u64,
    messages: Value,
    running: bool,
    queued_messages: Option<Value>,
    pending_approval: Option<Value>,
    context_usage: Option<Value>,
}

type StateWaiter = tokio::sync::oneshot::Sender<TaskStateReply>;
type RequestWaiter = tokio::sync::oneshot::Sender<Result<Value, String>>;

static STATE_WAITERS: OnceLock<std::sync::Mutex<HashMap<String, StateWaiter>>> = OnceLock::new();
static REQUEST_WAITERS: OnceLock<std::sync::Mutex<HashMap<String, RequestWaiter>>> = OnceLock::new();

fn state_waiters() -> &'static std::sync::Mutex<HashMap<String, StateWaiter>> {
    STATE_WAITERS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn request_waiters() -> &'static std::sync::Mutex<HashMap<String, RequestWaiter>> {
    REQUEST_WAITERS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// 手机发送被桌面拒绝（任务不存在等）：v1 简化为日志（后续可回错误帧）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSendRejectedArgs {
    pub task_id: String,
}

#[tauri::command]
pub async fn remote_bridge_send_rejected(args: BridgeSendRejectedArgs) -> Result<(), String> {
    eprintln!("[remote-server] send rejected for task {}", args.task_id);
    Ok(())
}

// ============================================================
// MCP Server 可调用的公开辅助接口
// （mcp_server.rs 通过 crate::remote_server:: 调用，共享鉴权与 webview 桥接）
// ============================================================

/// 暴露客户端 IP 解析（避免 mcp_server 重复实现 XFF/CF-IP 解析逻辑）。
pub fn resolve_client_ip_pub(headers: &HeaderMap, addr: &SocketAddr) -> String {
    resolve_client_ip(headers, addr)
}

/// 统一鉴权入口（复用 verify_token，屏蔽内部 via_query 返回值细节）。
pub fn check_auth(
    query_token: Option<&str>,
    headers: &HeaderMap,
    ip: &str,
) -> Result<(), StatusCode> {
    verify_token(query_token, headers, ip).map(|_| ())
}

/// 向 webview 发起通用 reqId 型请求并等待应答（MCP tools 核心桥接函数）。
/// 复用 REQUEST_WAITERS 与 remote-bridge:request 事件机制，15s 超时。
pub async fn webview_request(
    app: &AppHandle,
    kind: &str,
    payload: Value,
) -> Result<Value, String> {
    let req_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Value, String>>();
    request_waiters()
        .lock()
        .expect("request waiters lock")
        .insert(req_id.clone(), tx);
    let _ = app.emit(
        "remote-bridge:request",
        serde_json::json!({ "reqId": &req_id, "kind": kind, "payload": payload }),
    );
    let result = match tokio::time::timeout(Duration::from_secs(15), rx).await {
        Ok(Ok(res)) => res,
        Ok(Err(_)) => Err("webview dropped the request".to_string()),
        Err(_) => Err(format!("webview request timed out ({kind})")),
    };
    // 无论成功或超时都清理等待器，防止内存泄漏
    request_waiters()
        .lock()
        .expect("request waiters lock")
        .remove(&req_id);
    result
}

/// 拉取单任务状态快照并序列化为 JSON Value（MCP get_task_status 工具使用）。
pub async fn webview_task_state_snapshot(app: &AppHandle, task_id: &str) -> Option<Value> {
    let reply = request_task_state_from_webview(app, task_id).await?;
    Some(serde_json::json!({
        "revision": reply.revision,
        "messages": reply.messages,
        "running": reply.running,
        "queuedMessages": reply.queued_messages,
        "pendingApproval": reply.pending_approval,
        "contextUsage": reply.context_usage,
    }))
}

/// 从快照中提取最新一条 Assistant 的正文内容
pub fn extract_latest_assistant_reply(snapshot: &Value) -> Option<String> {
    let messages = snapshot.get("messages")?.as_array()?;
    for msg in messages.iter().rev() {
        if msg.get("role").and_then(Value::as_str) == Some("assistant") {
            // 优先从 parts 提取 text
            if let Some(parts) = msg.get("parts").and_then(Value::as_array) {
                let mut accumulated = String::new();
                for part in parts {
                    if let Some(payload_str) = part.get("payload").and_then(Value::as_str) {
                        if let Ok(payload_json) = serde_json::from_str::<Value>(payload_str) {
                            if let Some(t) = payload_json.get("text").and_then(Value::as_str) {
                                if !t.trim().is_empty() {
                                    accumulated.push_str(t);
                                }
                            }
                        }
                    }
                }
                if !accumulated.trim().is_empty() {
                    return Some(accumulated);
                }
            }
            // 兜底提取 msg 本身的 text 字段
            if let Some(t) = msg.get("text").and_then(Value::as_str) {
                if !t.trim().is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

/// 阻塞等待指定任务执行完成（running == false），基于内部事件广播总线，超时自动返回。
pub async fn wait_for_task_completed(
    app: &AppHandle,
    task_id: &str,
    timeout: std::time::Duration,
) -> Result<Value, String> {
    // 1. 若当前任务已经处于非运行态，直接返回当前快照
    if let Some(snapshot) = webview_task_state_snapshot(app, task_id).await {
        let is_running = snapshot.get("running").and_then(Value::as_bool).unwrap_or(false);
        if !is_running {
            return Ok(snapshot);
        }
    }

    // 2. 订阅广播总线
    let mut rx = bridge_bus().subscribe();
    let start = std::time::Instant::now();

    loop {
        let remaining = timeout.checked_sub(start.elapsed());
        let Some(rem) = remaining else {
            return Err(format!("等待任务 {task_id} 完成超时（超过 {} 秒）", timeout.as_secs()));
        };

        tokio::select! {
            _ = tokio::time::sleep(rem) => {
                return Err(format!("等待任务 {task_id} 完成超时（超过 {} 秒）", timeout.as_secs()));
            }
            event = rx.recv() => {
                match event {
                    Ok(BridgeEvent::State { task_id: ev_task, running, .. }) => {
                        if ev_task == task_id && !running {
                            if let Some(snapshot) = webview_task_state_snapshot(app, task_id).await {
                                return Ok(snapshot);
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(snapshot) = webview_task_state_snapshot(app, task_id).await {
                            let is_running = snapshot.get("running").and_then(Value::as_bool).unwrap_or(false);
                            if !is_running {
                                return Ok(snapshot);
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return Err("总线通道已关闭".to_string());
                    }
                    _ => {}
                }
            }
        }
    }
}


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeAnswerStateArgs {
    pub task_id: String,
    pub revision: u64,
    pub messages: Value,
    pub running: bool,
    #[serde(default)]
    pub queued_messages: Option<Value>,
    #[serde(default)]
    pub pending_approval: Option<Value>,
    #[serde(default)]
    pub context_usage: Option<Value>,
}

/// webview 应答单任务状态请求。
#[tauri::command]
pub async fn remote_bridge_answer_state(args: BridgeAnswerStateArgs) -> Result<(), String> {
    let reply = TaskStateReply {
        revision: args.revision,
        messages: args.messages.clone(),
        running: args.running,
        queued_messages: args.queued_messages.clone(),
        pending_approval: args.pending_approval.clone(),
        context_usage: args.context_usage.clone(),
    };
    let waiter = state_waiters().lock().expect("waiters lock").remove(&args.task_id);
    if let Some(waiter) = waiter {
        let _ = waiter.send(reply);
    }
    let _ = bridge_bus().send(BridgeEvent::State {
        task_id: args.task_id,
        revision: args.revision,
        messages: args.messages,
        running: args.running,
        queued_messages: args.queued_messages,
        pending_approval: args.pending_approval,
        context_usage: args.context_usage,
    });
    Ok(())
}

// ---------------- 附件上传（手机 → 工作区 .ReinAgent/.temp/pasted/） ----------------

/// 文件名清洗：取 basename，替换路径分隔与控制字符，截断到 120 字符。
fn sanitize_upload_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("file").trim();
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '(' | ')' | ' ' | '[' | ']') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    let fallback = trimmed.is_empty();
    let mut name = if fallback { "file".to_string() } else { trimmed.to_string() };
    if name.len() > 120 {
        // 保留扩展名
        if let Some(dot) = name.rfind('.') {
            let ext = &name[dot..];
            let stem_len = 120 - ext.len();
            name = format!("{}{}", &name[..stem_len.max(1)], ext);
        } else {
            name.truncate(120);
        }
    }
    name
}

/// 解析任务对应的工作区根：任务 payload 的 project 字段 → 用户主目录 DefaultProject。
fn resolve_task_workspace_root(task_id: &str) -> Option<std::path::PathBuf> {
    let conn = crate::conversation_store::db_conn().ok()?;
    let payload: String = conn
        .query_row(
            "SELECT payload FROM task WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .ok()?;
    let project: Option<String> = serde_json::from_str::<Value>(&payload)
        .ok()
        .and_then(|v| v.get("project").and_then(|p| p.as_str()).map(|s| s.to_string()));
    let base = match project.filter(|p| !p.trim().is_empty()) {
        Some(p) => std::path::PathBuf::from(p),
        None => default_project_root(),
    };
    Some(base)
}

fn default_project_root() -> std::path::PathBuf {
    if let Some(home) = dirs::home_dir() {
        home.join(".ReinAgent").join("DefaultProject")
    } else if let Some(profile) = std::env::var_os("USERPROFILE") {
        std::path::PathBuf::from(profile).join(".ReinAgent").join("DefaultProject")
    } else {
        std::path::PathBuf::from("/tmp/ReinAgent/DefaultProject")
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadedAttachment {
    path: String,
    name: String,
    kind: String, // "image" | "file"
    size: u64,
}

/// 单文件大小上限（与桌面 fs_import_pasted_file 对齐：25MB）。
const UPLOAD_MAX_BYTES: usize = 25 * 1024 * 1024;

fn is_image_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

#[derive(Deserialize)]
struct UploadQuery {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    task_id: Option<String>,
}

async fn attachment_upload_handler(
    Query(query): Query<UploadQuery>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    mut multipart: axum::extract::Multipart,
) -> Result<axum::Json<Vec<UploadedAttachment>>, StatusCode> {
    let ip = resolve_client_ip(&headers, &addr);
    verify_token(query.token.as_deref(), &headers, &ip)?;
    let task_id = query.task_id.unwrap_or_default();
    let workspace_root = resolve_task_workspace_root(&task_id)
        .unwrap_or_else(default_project_root);
    let pasted_dir = workspace_root.join(".ReinAgent").join(".temp").join("pasted");
    std::fs::create_dir_all(&pasted_dir).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // 幂等补建 .ReinAgent/.gitignore（与 fs_cmd 同内容），手机上传产物对用户仓库隐形
    crate::fs_cmd::ensure_reinagent_gitignore(&workspace_root.join(".ReinAgent"));

    let mut uploaded = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?
    {
        let Some(file_name) = field.file_name().map(|s| s.to_string()) else {
            continue;
        };
        if file_name.is_empty() {
            continue;
        }
        let data = field
            .bytes()
            .await
            .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
        if data.is_empty() {
            continue;
        }
        if data.len() > UPLOAD_MAX_BYTES {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        let name = sanitize_upload_name(&file_name);
        let stamped = format!("remote-{}-{}", chrono::Local::now().format("%Y%m%d-%H%M%S%3f"), name);
        let dest = pasted_dir.join(&stamped);
        std::fs::write(&dest, &data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        uploaded.push(UploadedAttachment {
            path: dest.to_string_lossy().to_string(),
            name,
            kind: if is_image_name(&stamped) { "image" } else { "file" }.to_string(),
            size: data.len() as u64,
        });
    }
    Ok(axum::Json(uploaded))
}

// ---------------- 状态与配置命令 ----------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerStatus {
    pub available: bool,
    pub enabled: bool,
    pub port: u32,
    pub token: String,
    pub url: String,
    pub connected_clients: u32,
    pub network_mode: String,
    pub custom_url: String,
    pub tunnel_status: String,
    pub tunnel_url: Option<String>,
    pub tunnel_error: Option<String>,
    pub tunnel_progress: Option<String>,
}

fn local_ip() -> Option<String> {
    // 本机非环回 IPv4（UDP connect 不真正发包，仅路由表查询）
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("10.255.255.255:1").ok()?;
    socket.local_addr().ok().map(|a| a.ip().to_string())
}

fn derive_remote_url(mode: &str, token: &str, port: u32, custom_url: &str) -> String {
    match mode {
        "cloudflare" => {
            let t_status = crate::remote_tunnel::get_tunnel_status();
            if let Some(pub_url) = t_status.public_url {
                format!("{pub_url}/?token={token}")
            } else {
                "".to_string()
            }
        }
        "custom" => {
            let base = custom_url.trim().trim_end_matches('/');
            if !base.is_empty() {
                format!("{base}/?token={token}")
            } else {
                "".to_string()
            }
        }
        _ => {
            let ip = local_ip().unwrap_or_else(|| "127.0.0.1".to_string());
            format!("http://{ip}:{port}/?token={token}")
        }
    }
}

#[tauri::command]
pub async fn remote_server_status() -> Result<RemoteServerStatus, String> {
    let st = state();
    let enabled = st.enabled.load(Ordering::Relaxed);
    let port = st.port.load(Ordering::Relaxed);
    let token = kv_get(KV_TOKEN).unwrap_or_default();
    let mode = kv_get(KV_NETWORK_MODE).unwrap_or_else(|| "lan".to_string());
    let custom_url = kv_get(KV_CUSTOM_URL).unwrap_or_default();
    let tunnel = crate::remote_tunnel::get_tunnel_status();
    let url = derive_remote_url(&mode, &token, port, &custom_url);

    Ok(RemoteServerStatus {
        available: true,
        enabled,
        port,
        token,
        url,
        connected_clients: st.connected_clients.load(Ordering::Relaxed),
        network_mode: mode,
        custom_url,
        tunnel_status: tunnel.status,
        tunnel_url: tunnel.public_url,
        tunnel_error: tunnel.error,
        tunnel_progress: tunnel.progress,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerConfigArgs {
    pub enabled: bool,
    pub port: Option<u32>,
    pub reset_token: Option<bool>,
    pub network_mode: Option<String>,
    pub custom_url: Option<String>,
}

fn ensure_token() -> String {
    if let Some(token) = kv_get(KV_TOKEN).filter(|t| !t.is_empty()) {
        return token;
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    kv_set(KV_TOKEN, &token);
    kv_set(KV_TOKEN_HASH, &sha256_hex(&token));
    token
}

#[tauri::command]
pub async fn remote_server_config(
    app: AppHandle,
    args: RemoteServerConfigArgs,
) -> Result<RemoteServerStatus, String> {
    let st = state();
    if let Some(port) = args.port.filter(|p| (1..=65535).contains(p)) {
        st.port.store(port, Ordering::Relaxed);
        kv_set(KV_PORT, &port.to_string());
    }
    if let Some(ref mode) = args.network_mode {
        kv_set(KV_NETWORK_MODE, mode);
    }
    if let Some(ref cu) = args.custom_url {
        kv_set(KV_CUSTOM_URL, cu);
    }
    if args.reset_token == Some(true) {
        let token = uuid::Uuid::new_v4().simple().to_string();
        kv_set(KV_TOKEN, &token);
        kv_set(KV_TOKEN_HASH, &sha256_hex(&token));
        // token 变更 = 立即踢掉所有已连接客户端
        *st.shutdown_tx.lock().expect("shutdown lock") = None;
        restart_server(&app)?;
    }
    kv_set(KV_ENABLED, if args.enabled { "1" } else { "0" });
    st.enabled.store(args.enabled, Ordering::Relaxed);
    restart_server(&app)?;

    let current_mode = kv_get(KV_NETWORK_MODE).unwrap_or_else(|| "lan".to_string());
    let port = st.port.load(Ordering::Relaxed);
    if args.enabled && current_mode == "cloudflare" {
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::remote_tunnel::start_cloudflare_tunnel(app_handle, port).await;
        });
    } else {
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            crate::remote_tunnel::stop_tunnel(Some(&app_handle)).await;
        });
    }

    emit_status(&app);
    remote_server_status().await
}

fn emit_status(app: &AppHandle) {
    let st = state();
    let enabled = st.enabled.load(Ordering::Relaxed);
    let port = st.port.load(Ordering::Relaxed);
    let token = kv_get(KV_TOKEN).unwrap_or_default();
    let mode = kv_get(KV_NETWORK_MODE).unwrap_or_else(|| "lan".to_string());
    let custom_url = kv_get(KV_CUSTOM_URL).unwrap_or_default();
    let tunnel = crate::remote_tunnel::get_tunnel_status();
    let url = derive_remote_url(&mode, &token, port, &custom_url);

    let _ = app.emit(
        "remote-server:status",
        serde_json::json!({
            "available": true,
            "enabled": enabled,
            "port": port,
            "connectedClients": st.connected_clients.load(Ordering::Relaxed),
            "url": url,
            "token": token,
            "networkMode": mode,
            "customUrl": custom_url,
            "tunnelStatus": tunnel.status,
            "tunnelUrl": tunnel.public_url,
            "tunnelError": tunnel.error,
            "tunnelProgress": tunnel.progress,
        }),
    );
}

// ---------------- 服务器生命周期 ----------------

fn restart_server(app: &AppHandle) -> Result<(), String> {
    let st = state();
    // 先停旧实例
    if let Some(tx) = st.shutdown_tx.lock().expect("shutdown lock").take() {
        let _ = tx.send(true);
    }
    if !st.enabled.load(Ordering::Relaxed) {
        st.connected_clients.store(0, Ordering::Relaxed);
        return Ok(());
    }
    let token = ensure_token();
    *st.token_hash.lock().expect("token hash lock") = sha256_hex(&token);

    let port = st.port.load(Ordering::Relaxed);
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    *st.shutdown_tx.lock().expect("shutdown lock") = Some(shutdown_tx);
    *st.handle.lock().expect("handle lock") = Some(app.clone());

    let app_for_router = app.clone();
    let runtime_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let router = Router::new()
            .route("/", get(page_handler))
            .route("/assets/{*path}", get(remote_asset_handler))
            .route("/api/attachment", axum::routing::post(attachment_upload_handler))
            .route("/ws", get(ws_handler))
            // ---- MCP Server 端点（协议 2024-11-05）----
            // 外部大模型（Claude Desktop、Cursor 等）通过 SSE 长连接接收响应，
            // 通过 POST /mcp/message 发送 JSON-RPC 请求。
            // 鉴权与端口复用手机远控同一基础设施，无需额外配置。
            .route("/mcp/sse", get(crate::mcp_server::mcp_sse_handler))
            .route("/mcp/message", axum::routing::post(crate::mcp_server::mcp_message_handler))
            .with_state(app_for_router);
        let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port as u16)).await {
            Ok(l) => l,
            Err(err) => {
                let _ = runtime_app.emit(
                    "remote-server:status",
                    serde_json::json!({ "enabled": false, "error": format!("端口 {port} 监听失败: {err}") }),
                );
                return;
            }
        };
        let _ = tokio::time::timeout(
            Duration::MAX,
            axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(async move {
                    let mut rx = shutdown_rx;
                    loop {
                        if *rx.borrow_and_update() {
                            break;
                        }
                        if rx.changed().await.is_err() {
                            break;
                        }
                    }
                }),
        )
        .await;
    });
    Ok(())
}

/// 应用启动时恢复持久化配置（main setup 调用）。
pub fn restore_on_startup(app: &AppHandle) {
    // 无条件回收上次遗留的孤儿隧道：上次可能崩溃/强杀退出而 PID 文件仍在。
    // 必须放在模式判断之外——若上次崩溃后用户已把远控改回/关闭非 cloudflare 模式，
    // 残留的 cloudflared 就不会再被任何启动路径触及，只能在这里收掉。
    crate::remote_tunnel::reclaim_orphan_tunnel();

    if let Some(port) = kv_get(KV_PORT).and_then(|v| v.parse().ok()) {
        state().port.store(port, Ordering::Relaxed);
    }
    if let Some(hash) = kv_get(KV_TOKEN_HASH) {
        *state().token_hash.lock().expect("token hash lock") = hash;
    }
    let enabled = kv_get(KV_ENABLED).as_deref() == Some("1");
    state().enabled.store(enabled, Ordering::Relaxed);
    if enabled {
        if let Err(err) = restart_server(app) {
            eprintln!("[remote-server] startup failed: {err}");
        }
        let mode = kv_get(KV_NETWORK_MODE).unwrap_or_else(|| "lan".to_string());
        let port = state().port.load(Ordering::Relaxed);
        if mode == "cloudflare" {
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::remote_tunnel::start_cloudflare_tunnel(app_handle, port).await;
            });
        }
    }
}

#[cfg(test)]
mod serde_tests {
    use super::*;

    #[test]
    fn subscribe_parses_camel_case_req_id() {
        let json = r#"{"op":"subscribe","reqId":"r1","taskId":"t1"}"#;
        let parsed: Result<ClientMessage, _> = serde_json::from_str(json);
        match parsed.expect("deserialize subscribe with camelCase fields") {
            ClientMessage::Subscribe { req_id, task_id } => {
                assert_eq!(req_id, "r1");
                assert_eq!(task_id, "t1");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_resolve_client_ip_headers() {
        use axum::http::HeaderValue;
        let connect_addr: SocketAddr = "127.0.0.1:54321".parse().unwrap();
        let mut headers = HeaderMap::new();

        // No headers: falls back to connect_addr
        assert_eq!(resolve_client_ip(&headers, &connect_addr), "127.0.0.1");

        // X-Forwarded-For
        headers.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.195, 70.41.3.18"));
        assert_eq!(resolve_client_ip(&headers, &connect_addr), "203.0.113.195");

        // CF-Connecting-IP takes precedence over XFF
        headers.insert("cf-connecting-ip", HeaderValue::from_static("198.51.100.42"));
        assert_eq!(resolve_client_ip(&headers, &connect_addr), "198.51.100.42");
    }

    #[test]
    fn test_loopback_never_blacklisted() {
        for _ in 0..10 {
            assert!(!record_auth_failure("127.0.0.1"));
            assert!(!record_auth_failure("::1"));
            assert!(!record_auth_failure("localhost"));
        }
        assert!(!is_blacklisted("127.0.0.1"));
        assert!(!is_blacklisted("::1"));
        assert!(!is_blacklisted("localhost"));
    }
    #[test]
    fn send_parses_null_task_id_and_attachments() {
        let json = r#"{"op":"send","reqId":"r2","taskId":null,"text":"hi","attachments":[{"path":"C:/x/a.png","name":"a.png","kind":"image"}]}"#;
        let parsed: ClientMessage = serde_json::from_str(json).expect("send with null taskId");
        match parsed {
            ClientMessage::Send { req_id, task_id, text, attachments } => {
                assert_eq!(req_id, "r2");
                assert_eq!(task_id, None);
                assert_eq!(text, "hi");
                assert_eq!(attachments.len(), 1);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn switch_task_parses_camel_case() {
        let json = r#"{"op":"switch_task","reqId":"r3","taskId":"t9"}"#;
        match serde_json::from_str::<ClientMessage>(json).expect("switch_task") {
            ClientMessage::SwitchTask { req_id, task_id } => {
                assert_eq!(req_id, "r3");
                assert_eq!(task_id, "t9");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn sanitize_upload_name_keeps_basename_and_strips_unsafe() {
        assert_eq!(sanitize_upload_name("a/b/c.txt"), "c.txt");
        assert_eq!(sanitize_upload_name("../../../etc/passwd"), "passwd");
        assert_eq!(sanitize_upload_name(""), "file");
        assert_eq!(sanitize_upload_name("..."), "file");
        assert!(sanitize_upload_name("hello*?.md").ends_with(".md"));
        assert!(!sanitize_upload_name("hello*?.md").contains('*'));
    }

    #[test]
    fn sanitize_upload_name_truncates_but_keeps_extension() {
        let long = format!("{}.png", "x".repeat(200));
        let out = sanitize_upload_name(&long);
        assert!(out.len() <= 124);
        assert!(out.ends_with(".png"));
    }

    #[test]
    fn is_image_name_covers_common_extensions() {
        assert!(is_image_name("a.PNG"));
        assert!(is_image_name("b.jpeg"));
        assert!(!is_image_name("c.pdf"));
    }
}

