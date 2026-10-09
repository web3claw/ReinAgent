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

// ---------------- 手机单页（批 3：内联 HTML，include_str! 编译进二进制） ----------------

const REMOTE_PAGE: &str = include_str!("remote_page.html");
const MARKED_JS: &str = include_str!("../remote_assets/marked.umd.js");
const PURIFY_JS: &str = include_str!("../remote_assets/purify.min.js");

/// 组装手机页面：把 markdown 渲染库注入占位符（构建一次后缓存）。
fn build_remote_page() -> &'static String {
    static BUILT: OnceLock<String> = OnceLock::new();
    BUILT.get_or_init(|| {
        REMOTE_PAGE
            .replace("/*__MARKED_JS__*/", MARKED_JS)
            .replace("/*__PURIFY_JS__*/", PURIFY_JS)
    })
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
    let ip = resolve_client_ip(&headers, &addr);
    // 通过 query token 鉴权时种 HttpOnly Cookie：页面 replaceState 清掉 URL 里的
    // token 后，刷新仍能凭 Cookie 通过（对齐 ZCode hasValidLiteToken 语义）。
    let via_query_token = verify_token(query.token.as_deref(), &headers, &ip)?;
    let mut response = ([("content-type", "text/html; charset=utf-8")], build_remote_page().clone()).into_response();
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
    Snapshot {
        tasks: Vec<Value>,
    },
    State {
        task_id: String,
        revision: u64,
        messages: Value,
        running: bool,
    },
    ApprovalPending {
        task_id: String,
        tool_name: String,
        args: Value,
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
    #[serde(rename = "subscribe")]
    Subscribe { req_id: String, task_id: String },
    #[serde(rename = "send")]
    Send { req_id: String, task_id: String, text: String },
    #[serde(rename = "approve")]
    Approve { req_id: String, task_id: String, decision: Value },
    #[serde(rename = "stop")]
    Stop { req_id: String, task_id: String },
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
                        BridgeEvent::State { task_id, revision, messages, running } => {
                            if guard.subscribed.contains(&task_id) {
                                guard.send(ServerMessage::State { task_id, revision, messages, running });
                            }
                        }
                        BridgeEvent::ApprovalPending { task_id, tool_name, args } => {
                            if guard.subscribed.contains(&task_id) {
                                guard.send(ServerMessage::ApprovalPending { task_id, tool_name, args });
                            }
                        }
                        BridgeEvent::Snapshot { tasks } => {
                            guard.send(ServerMessage::Snapshot { tasks });
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
            // hello 后立刻推一份任务快照
            let tasks = request_snapshot_from_webview(&guard.app).await.unwrap_or_default();
            guard.send(ServerMessage::Snapshot { tasks });
        }
        ClientMessage::ListTasks { req_id } => {
            guard.send(ServerMessage::Accepted { req_id });
            let tasks = request_snapshot_from_webview(&guard.app).await.unwrap_or_default();
            guard.send(ServerMessage::Snapshot { tasks });
        }
        ClientMessage::Subscribe { req_id, task_id } => {
            guard.subscribed.insert(task_id.clone());
            guard.send(ServerMessage::Accepted { req_id });
            // 立即推一次当前状态
            let state = request_task_state_from_webview(&guard.app, &task_id).await;
            if let Some((revision, messages, running)) = state {
                guard.send(ServerMessage::State { task_id, revision, messages, running });
            }
        }
        ClientMessage::Send { req_id, task_id, text } => {
            guard.send(ServerMessage::Accepted { req_id });
            let app = guard.app.clone();
            drop(guard);
            let _ = app.emit("remote-bridge:send", serde_json::json!({ "taskId": task_id, "text": text }));
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
    }
    Ok(())
}

// ---------------- 桥接：Rust ↔ webview ----------------

/// 桥接广播总线：webview 推来的状态/审批事件扇出给所有 WS 客户端。
#[derive(Clone, Debug)]
enum BridgeEvent {
    State { task_id: String, revision: u64, messages: Value, running: bool },
    ApprovalPending { task_id: String, tool_name: String, args: Value },
    Snapshot { tasks: Vec<Value> },
}

static BRIDGE_BUS: OnceLock<tokio::sync::broadcast::Sender<BridgeEvent>> = OnceLock::new();

fn bridge_bus() -> &'static tokio::sync::broadcast::Sender<BridgeEvent> {
    BRIDGE_BUS.get_or_init(|| tokio::sync::broadcast::channel(64).0)
}

/// webview → Rust 桥接入口（main.tsx 监听这些命令事件后调用对应命令）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStateArgs {
    pub task_id: String,
    pub revision: u64,
    pub messages: Value,
    pub running: bool,
}

#[tauri::command]
pub async fn remote_bridge_state(args: BridgeStateArgs) -> Result<(), String> {
    let _ = bridge_bus().send(BridgeEvent::State {
        task_id: args.task_id,
        revision: args.revision,
        messages: args.messages,
        running: args.running,
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

#[tauri::command]
pub async fn remote_bridge_snapshot(tasks: Vec<Value>) -> Result<(), String> {
    let _ = bridge_bus().send(BridgeEvent::Snapshot { tasks });
    Ok(())
}

/// webview 主动请求：让 WS 客户端收到最新任务快照（列表变化时调用）。
#[tauri::command]
pub async fn remote_bridge_notify_tasks() -> Result<(), String> {
    // webview 拿到 tasks 后调 remote_bridge_snapshot；这里只负责发事件请求快照
    if let Some(app) = state().handle.lock().expect("handle lock").clone() {
        let _ = app.emit("remote-bridge:tasks-changed", ());
    }
    Ok(())
}

/// webview 拉取快照：把请求转给 webview（webview 监听事件后调 remote_bridge_snapshot）。
async fn request_snapshot_from_webview(app: &AppHandle) -> Option<Vec<Value>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    snapshot_waiters().lock().expect("waiters lock").push(tx);
    let _ = app.emit("remote-bridge:need-snapshot", ());
    tokio::time::timeout(Duration::from_secs(5), rx).await.ok()?.ok()
}

async fn request_task_state_from_webview(app: &AppHandle, task_id: &str) -> Option<(u64, Value, bool)> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state_waiters().lock().expect("state waiters lock").insert(task_id.to_string(), tx);
    let _ = app.emit("remote-bridge:need-state", serde_json::json!({ "taskId": task_id }));
    tokio::time::timeout(Duration::from_secs(5), rx).await.ok()?.ok()
}

type SnapshotWaiter = tokio::sync::oneshot::Sender<Vec<Value>>;
type StateWaiter = tokio::sync::oneshot::Sender<(u64, Value, bool)>;

static SNAPSHOT_WAITERS: OnceLock<std::sync::Mutex<Vec<SnapshotWaiter>>> = OnceLock::new();
static STATE_WAITERS: OnceLock<std::sync::Mutex<HashMap<String, StateWaiter>>> = OnceLock::new();

fn snapshot_waiters() -> &'static std::sync::Mutex<Vec<SnapshotWaiter>> {
    SNAPSHOT_WAITERS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

fn state_waiters() -> &'static std::sync::Mutex<HashMap<String, StateWaiter>> {
    STATE_WAITERS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// webview 应答快照请求（remote_page 数据源）。
#[tauri::command]
pub async fn remote_bridge_answer_snapshot(tasks: Vec<Value>) -> Result<(), String> {
    let waiters: Vec<SnapshotWaiter> = snapshot_waiters().lock().expect("waiters lock").drain(..).collect();
    for waiter in waiters {
        let _ = waiter.send(tasks.clone());
    }
    // 同时广播给订阅客户端（列表变化推送）
    let _ = bridge_bus().send(BridgeEvent::Snapshot { tasks });
    Ok(())
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeAnswerStateArgs {
    pub task_id: String,
    pub revision: u64,
    pub messages: Value,
    pub running: bool,
}

/// webview 应答单任务状态请求。
#[tauri::command]
pub async fn remote_bridge_answer_state(args: BridgeAnswerStateArgs) -> Result<(), String> {
    let waiter = state_waiters().lock().expect("waiters lock").remove(&args.task_id);
    if let Some(waiter) = waiter {
        let _ = waiter.send((args.revision, args.messages.clone(), args.running));
    }
    let _ = bridge_bus().send(BridgeEvent::State {
        task_id: args.task_id,
        revision: args.revision,
        messages: args.messages,
        running: args.running,
    });
    Ok(())
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
            .route("/ws", get(ws_handler))
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
}

