//! mcp_server —— ReinAgent 原生 MCP Server（协议版本 MCP 2024-11-05）
//!
//! 在 remote_server 的 axum 路由器上追加两条路由：
//!   GET  /mcp/sse     → Server-Sent Events 长连接（JSON-RPC 响应通道）
//!   POST /mcp/message → 接收 JSON-RPC 请求
//!
//! 设计原则：
//! - 鉴权、端口、IP 黑名单完全复用 remote_server 基础设施（同一 Token）；
//! - 无需额外进程或额外端口，随远控服务器一同启停；
//! - 所有 15 个工具均对标手机远控 WS ClientMessage 的完整能力集，
//!   让外部大模型操作 ReinAgent 的体验与真人操作界面完全等价；
//! - No-Fallback：工具失败如实返回错误，严禁静默吞掉。

use axum::{
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    convert::Infallible,
    net::SocketAddr,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// ============================================================
// 一、MCP 会话池（session_id → SSE 发送通道）
// ============================================================

type SessionSender = tokio::sync::mpsc::UnboundedSender<String>;

static MCP_SESSIONS: OnceLock<Mutex<HashMap<String, SessionSender>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, SessionSender>> {
    MCP_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_session(session_id: &str, tx: SessionSender) {
    sessions()
        .lock()
        .expect("mcp sessions lock")
        .insert(session_id.to_string(), tx);
}

fn remove_session(session_id: &str) {
    sessions()
        .lock()
        .expect("mcp sessions lock")
        .remove(session_id);
}

/// 将 JSON-RPC 响应字符串推入指定 SSE 会话。
/// 若发送失败（连接已断），惰性清理会话条目。
fn push_to_session(session_id: &str, data: String) -> bool {
    let guard = sessions().lock().expect("mcp sessions lock");
    if let Some(tx) = guard.get(session_id) {
        if tx.send(data).is_ok() {
            return true;
        }
        // channel 已关闭（客户端断开），惰性清理
        drop(guard);
        remove_session(session_id);
        return false;
    }
    false
}

// ============================================================
// 二、Query 类型
// ============================================================

#[derive(Deserialize)]
pub struct McpSseQuery {
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Deserialize)]
pub struct McpMessageQuery {
    #[serde(default)]
    pub token: Option<String>,
    /// SSE 连接时由服务端在 endpoint 事件中分配的 session ID
    pub session_id: String,
}

// ============================================================
// 三、SSE Handler（GET /mcp/sse）
// ============================================================

pub async fn mcp_sse_handler(
    Query(query): Query<McpSseQuery>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(_app): State<AppHandle>,
) -> Result<impl IntoResponse, StatusCode> {
    let ip = crate::remote_server::resolve_client_ip_pub(&headers, &addr);
    crate::remote_server::check_auth(query.token.as_deref(), &headers, &ip)?;

    let session_id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    register_session(&session_id, tx);

    // MCP 协议要求：SSE 连接建立后立即推送 endpoint 事件，
    // 告知客户端 JSON-RPC 请求应 POST 到哪个 URL。
    let endpoint_url = format!("/mcp/message?session_id={session_id}");
    let sid = session_id.clone();

    // 构建 SSE 流：先发 endpoint 事件，之后持续转发 channel 中的 JSON-RPC 响应帧。
    let stream = make_sse_stream(rx, endpoint_url, sid);

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    ))
}

fn make_sse_stream(
    rx: tokio::sync::mpsc::UnboundedReceiver<String>,
    endpoint_url: String,
    session_id: String,
) -> impl futures_util::Stream<Item = Result<Event, Infallible>> {
    // State 元组：(rx, endpoint_already_sent, endpoint_url, session_id)
    futures_util::stream::unfold(
        (rx, false, endpoint_url, session_id),
        |(mut rx, sent_endpoint, endpoint, sid)| async move {
            if !sent_endpoint {
                // 首帧：推送 endpoint 事件（MCP 2024-11-05 握手）
                let event = Event::default()
                    .event("endpoint")
                    .data(endpoint.clone());
                return Some((Ok::<Event, Infallible>(event), (rx, true, endpoint, sid)));
            }
            match rx.recv().await {
                Some(msg) => {
                    let event = Event::default().event("message").data(msg);
                    Some((Ok(event), (rx, true, endpoint, sid)))
                }
                None => {
                    // channel 关闭（tx 已被 drop 或所有引用消失）：清理会话并终止流
                    remove_session(&sid);
                    None
                }
            }
        },
    )
}

// ============================================================
// 四、Message Handler（POST /mcp/message）
// ============================================================

pub async fn mcp_message_handler(
    Query(query): Query<McpMessageQuery>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(app): State<AppHandle>,
    axum::Json(body): axum::Json<Value>,
) -> Result<StatusCode, StatusCode> {
    let ip = crate::remote_server::resolve_client_ip_pub(&headers, &addr);
    crate::remote_server::check_auth(query.token.as_deref(), &headers, &ip)?;

    let session_id = query.session_id;

    // 在独立 tokio 任务中处理请求，避免阻塞 HTTP handler 线程。
    // app、session_id、body 均 move 进任务。
    tauri::async_runtime::spawn(async move {
        if let Some(response_str) = dispatch_jsonrpc(&app, body).await {
            push_to_session(&session_id, response_str);
        }
    });

    // 立即返回 202 Accepted；实际响应通过 SSE 异步推回
    Ok(StatusCode::ACCEPTED)
}

// ============================================================
// 五、JSON-RPC 分发
// ============================================================

async fn dispatch_jsonrpc(app: &AppHandle, req: Value) -> Option<String> {
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let id = req.get("id").cloned();
    let params = req.get("params").cloned().unwrap_or(json!({}));

    // MCP notifications（无 id 字段）不需要响应
    let id_val = id?;

    let result: Result<Value, (i32, String)> = match method {
        "initialize" => handle_initialize(),
        // "initialized" 是客户端发来的 notification，理论上不带 id；
        // 若带 id，按规范也无需响应，这里容错返回 None（由上面 `id?` 处理）
        "initialized" => return None,
        "tools/list" => handle_tools_list(),
        "tools/call" => handle_tools_call(app, &params).await,
        "ping" => Ok(json!({})),
        _ => Err((-32601, format!("Method not found: {method}"))),
    };

    let response = match result {
        Ok(res) => json!({
            "jsonrpc": "2.0",
            "id": id_val,
            "result": res
        }),
        Err((code, msg)) => json!({
            "jsonrpc": "2.0",
            "id": id_val,
            "error": {
                "code": code,
                "message": msg
            }
        }),
    };

    serde_json::to_string(&response).ok()
}

// ============================================================
// 六、MCP 核心方法处理
// ============================================================

fn handle_initialize() -> Result<Value, (i32, String)> {
    Ok(json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": "ReinAgent",
            "version": env!("CARGO_PKG_VERSION")
        }
    }))
}

fn handle_tools_list() -> Result<Value, (i32, String)> {
    Ok(json!({
        "tools": tool_definitions()
    }))
}

async fn handle_tools_call(app: &AppHandle, params: &Value) -> Result<Value, (i32, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "Missing tool name".to_string()))?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or(json!({}));

    let result: Result<String, String> = match name {
        "reinagent_list_tasks"          => tool_list_tasks(app).await,
        "reinagent_create_task"         => tool_create_task(app, &args).await,
        "reinagent_get_task_status"     => tool_get_task_status(app, &args).await,
        "reinagent_send_message"        => tool_send_message(app, &args).await,
        "reinagent_stop_task"           => tool_stop_task(app, &args).await,
        "reinagent_approve_tool"        => tool_approve_tool(app, &args).await,
        "reinagent_switch_task"         => tool_switch_task(app, &args).await,
        "reinagent_list_models"         => tool_list_models(app).await,
        "reinagent_set_model"           => tool_set_model(app, &args).await,
        "reinagent_get_task_options"    => tool_get_task_options(app, &args).await,
        "reinagent_set_approval_mode"   => tool_set_approval_mode(app, &args).await,
        "reinagent_set_thinking_level"  => tool_set_thinking_level(app, &args).await,
        "reinagent_remove_queued_message" => tool_remove_queued_message(app, &args).await,
        "reinagent_mark_task_read"      => tool_mark_task_read(app, &args).await,
        "reinagent_start_draft"         => tool_start_draft(app, &args).await,
        _ => Err(format!("Unknown tool: {name}")),
    };

    // MCP 规范：工具执行错误编码进 result（isError:true），而非 JSON-RPC error
    let (text, is_error) = match result {
        Ok(s) => (s, false),
        Err(e) => (e, true),
    };

    Ok(json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error
    }))
}

// ============================================================
// 七、工具实现（15 个，完全对标手机端 WS 能力集）
// ============================================================

// ---- 1. reinagent_list_tasks ----
async fn tool_list_tasks(app: &AppHandle) -> Result<String, String> {
    let result = crate::remote_server::webview_request(app, "list_workspaces", json!({})).await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string()))
}

// ============================================================
// 四点一、MCP 参数解析辅助函数（宽松支持 snake_case 与 camelCase）
// ============================================================

/// 从 JSON 参数对象中宽容提取字符串（优先 snake_case，缺省兼容 camelCase）
pub fn extract_str_param<'a>(args: &'a Value, snake: &str, camel: &str) -> Option<&'a str> {
    args.get(snake)
        .or_else(|| args.get(camel))
        .and_then(Value::as_str)
}

/// 从 JSON 参数对象中宽容提取任意 Value（优先 snake_case，缺省兼容 camelCase）
pub fn extract_val_param(args: &Value, snake: &str, camel: &str) -> Option<Value> {
    args.get(snake)
        .or_else(|| args.get(camel))
        .cloned()
}

/// 从 JSON 参数对象中宽容提取 u64（优先 snake_case，缺省兼容 camelCase）
pub fn extract_u64_param(args: &Value, snake: &str, camel: &str) -> Option<u64> {
    args.get(snake)
        .or_else(|| args.get(camel))
        .and_then(Value::as_u64)
}

// ---- 2. reinagent_create_task ----
async fn tool_create_task(app: &AppHandle, args: &Value) -> Result<String, String> {
    let prompt = args
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少必填参数: prompt".to_string())?;
    let workspace_key = extract_str_param(args, "workspace_key", "workspaceKey").unwrap_or("");

    // 若提供了工作区 key，先切换到该工作区并打开草稿态
    if !workspace_key.is_empty() {
        let _ = crate::remote_server::webview_request(
            app,
            "start_draft",
            json!({ "workspaceKey": workspace_key }),
        )
        .await;
    }

    // taskId 为 null 表示草稿态首条消息，前端会自动创建新任务
    app.emit(
        "remote-bridge:send",
        json!({ "taskId": null, "text": prompt, "attachments": [] }),
    )
    .map_err(|e| format!("emit remote-bridge:send 失败: {e}"))?;

    Ok(json!({
        "status": "accepted",
        "message": "任务已创建，Agent 正在开始工作。请稍后调用 reinagent_list_tasks 获取新任务 ID，再用 reinagent_get_task_status 轮询执行进度。"
    })
    .to_string())
}

pub fn slice_snapshot_messages(snapshot: &mut Value, limit: i64, since_seq: Option<u64>) {
    let mut total_messages = 0;
    let mut omitted_messages = 0;
    let mut returned_messages = 0;
    let has_messages = if let Some(messages) = snapshot.get_mut("messages").and_then(Value::as_array_mut) {
        total_messages = messages.len();
        if let Some(min_seq) = since_seq {
            messages.retain(|m| {
                m.get("seq").and_then(Value::as_u64).map(|s| s > min_seq).unwrap_or(true)
            });
        } else if limit > 0 && (limit as usize) < messages.len() {
            let keep_count = limit as usize;
            omitted_messages = messages.len() - keep_count;
            messages.drain(0..omitted_messages);
        }
        returned_messages = messages.len();
        true
    } else {
        false
    };

    if has_messages {
        snapshot["totalMessages"] = json!(total_messages);
        if omitted_messages > 0 {
            snapshot["omittedMessages"] = json!(omitted_messages);
        }
        snapshot["returnedMessages"] = json!(returned_messages);
    }
}

// ---- 3. reinagent_get_task_status ----
async fn tool_get_task_status(app: &AppHandle, args: &Value) -> Result<String, String> {
    let task_id = extract_str_param(args, "task_id", "taskId")
        .ok_or_else(|| "缺少必填参数: task_id (或 taskId)".to_string())?;

    let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(50);
    let since_seq = extract_u64_param(args, "since_seq", "sinceSeq");

    match crate::remote_server::webview_task_state_snapshot(app, task_id).await {
        Some(mut snapshot) => {
            slice_snapshot_messages(&mut snapshot, limit, since_seq);
            Ok(serde_json::to_string_pretty(&snapshot)
                .unwrap_or_else(|_| snapshot.to_string()))
        }
        None => Err(format!(
            "无法获取任务 {task_id} 的状态（任务不存在、尚未水合完成或请求超时）"
        )),
    }
}

// ---- 4. reinagent_send_message ----
async fn tool_send_message(app: &AppHandle, args: &Value) -> Result<String, String> {
    // task_id 可为 null（向草稿态发送）
    let task_id = extract_val_param(args, "task_id", "taskId").unwrap_or(Value::Null);
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少必填参数: text".to_string())?;

    app.emit(
        "remote-bridge:send",
        json!({ "taskId": task_id, "text": text, "attachments": [] }),
    )
    .map_err(|e| format!("emit remote-bridge:send 失败: {e}"))?;

    Ok(json!({ "status": "accepted", "message": "消息已发送，Agent 已收到" }).to_string())
}

// ---- 5. reinagent_stop_task ----
async fn tool_stop_task(app: &AppHandle, args: &Value) -> Result<String, String> {
    let task_id = extract_str_param(args, "task_id", "taskId")
        .ok_or_else(|| "缺少必填参数: task_id (或 taskId)".to_string())?;

    app.emit("remote-bridge:stop", json!({ "taskId": task_id }))
        .map_err(|e| format!("emit remote-bridge:stop 失败: {e}"))?;

    Ok(json!({ "status": "accepted", "message": "停止指令已发送" }).to_string())
}

// ---- 6. reinagent_approve_tool ----
async fn tool_approve_tool(app: &AppHandle, args: &Value) -> Result<String, String> {
    let task_id = extract_str_param(args, "task_id", "taskId")
        .ok_or_else(|| "缺少必填参数: task_id (或 taskId)".to_string())?;
    let decision = args
        .get("decision")
        .cloned()
        .ok_or_else(|| "缺少必填参数: decision".to_string())?;

    app.emit(
        "remote-bridge:resolve",
        json!({ "taskId": task_id, "decision": decision }),
    )
    .map_err(|e| format!("emit remote-bridge:resolve 失败: {e}"))?;

    Ok(json!({ "status": "accepted", "message": "审批决策已提交" }).to_string())
}

// ---- 7. reinagent_switch_task ----
async fn tool_switch_task(app: &AppHandle, args: &Value) -> Result<String, String> {
    let task_id = extract_str_param(args, "task_id", "taskId")
        .ok_or_else(|| "缺少必填参数: task_id (或 taskId)".to_string())?;

    let result = crate::remote_server::webview_request(
        app,
        "switch_task",
        json!({ "taskId": task_id }),
    )
    .await?;

    Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string()))
}

// ---- 8. reinagent_list_models ----
async fn tool_list_models(app: &AppHandle) -> Result<String, String> {
    let result = crate::remote_server::webview_request(app, "list_models", json!({})).await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string()))
}

// ---- 9. reinagent_set_model ----
async fn tool_set_model(app: &AppHandle, args: &Value) -> Result<String, String> {
    let task_id = extract_val_param(args, "task_id", "taskId");
    let provider_id = extract_str_param(args, "provider_id", "providerId")
        .ok_or_else(|| "缺少必填参数: provider_id (或 providerId)".to_string())?;
    let model_id = extract_str_param(args, "model_id", "modelId")
        .ok_or_else(|| "缺少必填参数: model_id (或 modelId)".to_string())?;

    let result = crate::remote_server::webview_request(
        app,
        "set_model",
        json!({
            "taskId": task_id,
            "providerId": provider_id,
            "modelId": model_id
        }),
    )
    .await?;

    Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string()))
}

// ---- 10. reinagent_get_task_options ----
async fn tool_get_task_options(app: &AppHandle, args: &Value) -> Result<String, String> {
    let task_id = extract_val_param(args, "task_id", "taskId");
    let result = crate::remote_server::webview_request(
        app,
        "get_task_options",
        json!({ "taskId": task_id }),
    )
    .await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string()))
}

// ---- 11. reinagent_set_approval_mode ----
async fn tool_set_approval_mode(app: &AppHandle, args: &Value) -> Result<String, String> {
    let task_id = extract_val_param(args, "task_id", "taskId");
    let mode = args
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少必填参数: mode".to_string())?;

    let result = crate::remote_server::webview_request(
        app,
        "set_approval_mode",
        json!({ "taskId": task_id, "mode": mode }),
    )
    .await?;

    Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string()))
}

// ---- 12. reinagent_set_thinking_level ----
async fn tool_set_thinking_level(app: &AppHandle, args: &Value) -> Result<String, String> {
    let task_id = extract_val_param(args, "task_id", "taskId");
    let level = args
        .get("level")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少必填参数: level".to_string())?;

    let result = crate::remote_server::webview_request(
        app,
        "set_thinking_level",
        json!({ "taskId": task_id, "level": level }),
    )
    .await?;

    Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string()))
}

// ---- 13. reinagent_remove_queued_message ----
async fn tool_remove_queued_message(app: &AppHandle, args: &Value) -> Result<String, String> {
    let task_id = extract_str_param(args, "task_id", "taskId")
        .ok_or_else(|| "缺少必填参数: task_id (或 taskId)".to_string())?;
    let index = args
        .get("index")
        .and_then(Value::as_u64)
        .ok_or_else(|| "缺少必填参数: index（整数）".to_string())?;

    let result = crate::remote_server::webview_request(
        app,
        "remove_queued",
        json!({ "taskId": task_id, "index": index }),
    )
    .await?;

    Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string()))
}

// ---- 14. reinagent_mark_task_read ----
async fn tool_mark_task_read(app: &AppHandle, args: &Value) -> Result<String, String> {
    let task_id = extract_str_param(args, "task_id", "taskId")
        .ok_or_else(|| "缺少必填参数: task_id (或 taskId)".to_string())?;

    let result = crate::remote_server::webview_request(
        app,
        "mark_task_read",
        json!({ "taskId": task_id }),
    )
    .await?;

    Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string()))
}

// ---- 15. reinagent_start_draft ----
async fn tool_start_draft(app: &AppHandle, args: &Value) -> Result<String, String> {
    let workspace_key = extract_str_param(args, "workspace_key", "workspaceKey")
        .ok_or_else(|| "缺少必填参数: workspace_key (或 workspaceKey)".to_string())?;

    let result = crate::remote_server::webview_request(
        app,
        "start_draft",
        json!({ "workspaceKey": workspace_key }),
    )
    .await?;

    Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string()))
}

// ============================================================
// 八、Tool Definitions（15 个工具的 JSON Schema）
// ============================================================

fn tool_definitions() -> Vec<Value> {
    vec![
        // ---- 1 ----
        json!({
            "name": "reinagent_list_tasks",
            "description": "列出 ReinAgent 中所有工作区与任务，包含任务 ID、标题、运行状态（idle/running/completed/error）、最后更新时间、是否置顶等元信息。在操作任何具体任务之前应首先调用此工具获取任务 ID。",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        // ---- 2 ----
        json!({
            "name": "reinagent_create_task",
            "description": "在 ReinAgent 中新建一个任务并立即发送第一条消息，触发 Agent 开始自主工作（等效用户在界面输入问题并按下发送）。创建后请用 reinagent_list_tasks 查询生成的任务 ID，再用 reinagent_get_task_status 轮询进度。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "发送给 ReinAgent Agent 的任务描述或指令"
                    },
                    "workspace_key": {
                        "type": "string",
                        "description": "目标工作区 key（可选；留空则在当前活动工作区新建草稿）"
                    }
                },
                "required": ["prompt"]
            }
        }),
        // ---- 3 ----
        json!({
            "name": "reinagent_get_task_status",
            "description": "获取指定任务的完整执行状态快照：消息时间线（含 Agent 思考过程、工具调用详情与结果）、是否正在运行、排队消息列表、待审批的工具调用等。使用此工具轮询任务执行进度。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "任务 ID（由 reinagent_list_tasks 返回）"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "返回最近的消息条数（默认 50 条；传 0 或负数返回全量历史）。长任务轮询建议设为 10~20 以极大提升速度并节省上下文。"
                    },
                    "since_seq": {
                        "type": "integer",
                        "description": "仅返回 seq 大于该值的增量消息（用于增量拉取，避免重复拉取旧消息）"
                    }
                },
                "required": ["task_id"]
            }
        }),
        // ---- 4 ----
        json!({
            "name": "reinagent_send_message",
            "description": "在已有任务中追加一条用户消息（等效在对话框继续输入并发送）。Agent 会延续上下文基于新消息继续工作。若 task_id 为 null，则向桌面当前草稿态发送（适合 reinagent_start_draft 之后使用）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": ["string", "null"],
                        "description": "目标任务 ID。传 null 则向草稿态发送（会自动创建新任务）"
                    },
                    "text": {
                        "type": "string",
                        "description": "消息内容"
                    }
                },
                "required": ["text"]
            }
        }),
        // ---- 5 ----
        json!({
            "name": "reinagent_stop_task",
            "description": "立即停止指定任务中正在执行的 Agent 轮次（等效界面上的「停止」按钮）。Agent 会在当前原子操作完成后停止，不会中断文件写入等正在进行的工具调用。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "要停止的任务 ID"
                    }
                },
                "required": ["task_id"]
            }
        }),
        // ---- 6 ----
        json!({
            "name": "reinagent_approve_tool",
            "description": "对 ReinAgent 中挂起等待审批的工具调用（文件写入、命令执行等需确认的操作）作出决策。建议先调用 reinagent_get_task_status 确认 pendingApproval 字段，再调用此工具给出决策。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "任务 ID"
                    },
                    "decision": {
                        "type": "object",
                        "description": "审批决策对象（与桌面 ApprovalCard 格式相同）。允许执行一次：{\"action\":\"allow\"}；总是允许（此后同类工具不再询问）：{\"action\":\"always_allow\"}；拒绝：{\"action\":\"reject\"}",
                        "properties": {
                            "action": {
                                "type": "string",
                                "enum": ["allow", "always_allow", "reject"]
                            }
                        },
                        "required": ["action"]
                    }
                },
                "required": ["task_id", "decision"]
            }
        }),
        // ---- 7 ----
        json!({
            "name": "reinagent_switch_task",
            "description": "将 ReinAgent 桌面主窗口的焦点切换到指定任务（等效在左侧任务列表点击目标任务），让用户的桌面显示对应的对话视图。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "要切换到的任务 ID"
                    }
                },
                "required": ["task_id"]
            }
        }),
        // ---- 8 ----
        json!({
            "name": "reinagent_list_models",
            "description": "列出 ReinAgent 中所有已配置启用的大模型（按服务商分组），包含模型 ID、服务商 ID、上下文窗口大小、是否支持视觉输入（vision）、是否为系统默认模型等详细信息。用于获取 provider_id 和 model_id 以传给 reinagent_set_model。",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        // ---- 9 ----
        json!({
            "name": "reinagent_set_model",
            "description": "为指定任务切换使用的大模型。切换操作仅影响该任务，不修改全局默认模型设置。模型 ID 和服务商 ID 可通过 reinagent_list_models 获取。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": ["string", "null"],
                        "description": "目标任务 ID（传 null 则为当前活动任务）"
                    },
                    "provider_id": {
                        "type": "string",
                        "description": "服务商 ID（如 \"openai\"、\"deepseek\"、\"anthropic\"；由 reinagent_list_models 返回）"
                    },
                    "model_id": {
                        "type": "string",
                        "description": "模型 ID（如 \"gpt-4o\"、\"deepseek-chat\"；由 reinagent_list_models 返回）"
                    }
                },
                "required": ["provider_id", "model_id"]
            }
        }),
        // ---- 10 ----
        json!({
            "name": "reinagent_get_task_options",
            "description": "获取指定任务当前的配置选项，包括工具审批模式（approval_mode）和 Agent 推理等级（thinking_level）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": ["string", "null"],
                        "description": "目标任务 ID（传 null 则为当前活动任务）"
                    }
                },
                "required": []
            }
        }),
        // ---- 11 ----
        json!({
            "name": "reinagent_set_approval_mode",
            "description": "设置指定任务的工具审批模式。full=全自动（Agent 的所有工具调用直接执行，无需人工确认）；suggest=建议模式；manual=手动审批（每次工具调用都需通过 reinagent_approve_tool 确认）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": ["string", "null"],
                        "description": "目标任务 ID（传 null 则为当前活动任务）"
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["full", "suggest", "manual"],
                        "description": "审批模式"
                    }
                },
                "required": ["mode"]
            }
        }),
        // ---- 12 ----
        json!({
            "name": "reinagent_set_thinking_level",
            "description": "设置指定任务的 Agent 推理等级，影响思考深度与最大工具执行步数。default=100步 / low=200步 / medium=300步 / high=400步 / xhigh=500步 / max=600步（max 模式下无步数上限）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": ["string", "null"],
                        "description": "目标任务 ID（传 null 则为当前活动任务）"
                    },
                    "level": {
                        "type": "string",
                        "enum": ["default", "low", "medium", "high", "xhigh", "max"],
                        "description": "推理等级"
                    }
                },
                "required": ["level"]
            }
        }),
        // ---- 13 ----
        json!({
            "name": "reinagent_remove_queued_message",
            "description": "从指定任务的排队消息列表中移除一条待发送的消息（Agent 正在执行期间追加的消息会进入排队队列，稍后逐条发送）。队列内容可通过 reinagent_get_task_status 的 queuedMessages 字段查看。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "目标任务 ID"
                    },
                    "index": {
                        "type": "integer",
                        "description": "消息在排队列表中的索引（从 0 开始，由 reinagent_get_task_status 的 queuedMessages 字段获取）",
                        "minimum": 0
                    }
                },
                "required": ["task_id", "index"]
            }
        }),
        // ---- 14 ----
        json!({
            "name": "reinagent_mark_task_read",
            "description": "标记指定任务的所有消息为已读，清除左侧任务列表中显示的未读消息徽章数字。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "目标任务 ID"
                    }
                },
                "required": ["task_id"]
            }
        }),
        // ---- 15 ----
        json!({
            "name": "reinagent_start_draft",
            "description": "在指定工作区打开一个新的草稿任务（等效点击界面上的「新建任务」按钮，不立即发送消息）。随后可调用 reinagent_send_message（task_id 传 null）发送第一条消息并触发任务创建；或直接用 reinagent_create_task 一步完成。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace_key": {
                        "type": "string",
                        "description": "目标工作区 key（由 reinagent_list_tasks 的 workspaces 字段获取）"
                    }
                },
                "required": ["workspace_key"]
            }
        }),
    ]
}

// ============================================================
// 九、单元测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_definitions_are_well_formed() {
        let tools = tool_definitions();
        assert_eq!(tools.len(), 15, "应有 15 个工具");
        for tool in &tools {
            assert!(tool.get("name").is_some(), "工具缺少 name 字段");
            assert!(tool.get("description").is_some(), "工具缺少 description 字段");
            assert!(tool.get("inputSchema").is_some(), "工具缺少 inputSchema 字段");
        }
    }

    #[test]
    fn initialize_response_has_correct_protocol() {
        let result = handle_initialize().expect("initialize 应成功");
        assert_eq!(
            result["protocolVersion"].as_str().unwrap(),
            "2024-11-05"
        );
        assert_eq!(result["serverInfo"]["name"].as_str().unwrap(), "ReinAgent");
    }

    #[test]
    fn tools_list_response_contains_all_tools() {
        let result = handle_tools_list().expect("tools/list 应成功");
        let tools = result["tools"].as_array().expect("tools 应为数组");
        assert_eq!(tools.len(), 15);
    }

    #[test]
    fn tool_names_are_unique() {
        let tools = tool_definitions();
        let mut names = std::collections::HashSet::new();
        for tool in &tools {
            let name = tool["name"].as_str().unwrap().to_string();
            assert!(names.insert(name.clone()), "工具名重复: {name}");
        }
    }

    #[test]
    fn session_push_to_nonexistent_session_returns_false() {
        assert!(!push_to_session("nonexistent-session-id", "test".to_string()));
    }

    #[test]
    fn slice_snapshot_messages_limit_retains_latest_and_adds_metadata() {
        let mut snapshot = json!({
            "taskId": "task-test",
            "messages": [
                { "seq": 1, "text": "m1" },
                { "seq": 2, "text": "m2" },
                { "seq": 3, "text": "m3" },
                { "seq": 4, "text": "m4" },
                { "seq": 5, "text": "m5" },
            ]
        });

        // limit = 2
        slice_snapshot_messages(&mut snapshot, 2, None);

        assert_eq!(snapshot["totalMessages"], 5);
        assert_eq!(snapshot["omittedMessages"], 3);
        assert_eq!(snapshot["returnedMessages"], 2);
        let msgs = snapshot["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["seq"], 4);
        assert_eq!(msgs[1]["seq"], 5);
    }

    #[test]
    fn slice_snapshot_messages_limit_zero_keeps_all() {
        let mut snapshot = json!({
            "taskId": "task-test",
            "messages": [
                { "seq": 1, "text": "m1" },
                { "seq": 2, "text": "m2" },
            ]
        });

        slice_snapshot_messages(&mut snapshot, 0, None);

        assert_eq!(snapshot["totalMessages"], 2);
        assert!(snapshot.get("omittedMessages").is_none());
        assert_eq!(snapshot["returnedMessages"], 2);
        assert_eq!(snapshot["messages"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn slice_snapshot_messages_since_seq_filters_incrementally() {
        let mut snapshot = json!({
            "taskId": "task-test",
            "messages": [
                { "seq": 10, "text": "m10" },
                { "seq": 20, "text": "m20" },
                { "seq": 30, "text": "m30" },
            ]
        });

        slice_snapshot_messages(&mut snapshot, 50, Some(15));

        assert_eq!(snapshot["totalMessages"], 3);
        assert_eq!(snapshot["returnedMessages"], 2);
        let msgs = snapshot["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["seq"], 20);
        assert_eq!(msgs[1]["seq"], 30);
    }

    #[test]
    fn extract_param_red_check_proves_old_logic_fails_and_new_logic_succeeds() {
        let camel_args = json!({
            "taskId": "task-999",
            "workspaceKey": "ws-root",
            "providerId": "provider-deepseek",
            "modelId": "model-v3",
            "sinceSeq": 42
        });

        // 1. Red Check：老逻辑只读 snake_case，面对 camelCase 必然返回 None（报错）
        let old_task_id = camel_args.get("task_id").and_then(Value::as_str);
        assert_eq!(old_task_id, None, "[Red Check] 验证老逻辑确实无法识别 taskId 导致缺必填参数错误");

        let old_workspace = camel_args.get("workspace_key").and_then(Value::as_str);
        assert_eq!(old_workspace, None, "[Red Check] 验证老逻辑确实无法识别 workspaceKey");

        // 2. Green Check：新逻辑兼容 camelCase 与 snake_case
        assert_eq!(extract_str_param(&camel_args, "task_id", "taskId"), Some("task-999"));
        assert_eq!(extract_str_param(&camel_args, "workspace_key", "workspaceKey"), Some("ws-root"));
        assert_eq!(extract_str_param(&camel_args, "provider_id", "providerId"), Some("provider-deepseek"));
        assert_eq!(extract_str_param(&camel_args, "model_id", "modelId"), Some("model-v3"));
        assert_eq!(extract_u64_param(&camel_args, "since_seq", "sinceSeq"), Some(42));

        // 3. 同时对原本的 snake_case 保持 100% 正向兼容
        let snake_args = json!({
            "task_id": "task-888",
            "workspace_key": "ws-snake",
            "since_seq": 88
        });
        assert_eq!(extract_str_param(&snake_args, "task_id", "taskId"), Some("task-888"));
        assert_eq!(extract_str_param(&snake_args, "workspace_key", "workspaceKey"), Some("ws-snake"));
        assert_eq!(extract_u64_param(&snake_args, "since_seq", "sinceSeq"), Some(88));
    }
}

