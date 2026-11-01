//! 微信 iLink 消息网关（2026-11-01）：`getupdates` 长轮询收消息 +
//! `sendmessage` 被动回复，与 QQ 网关（qqbot_gateway.rs）同架构。
//!
//! 协议要点（openclaw-weixin 源码 + 实测）：
//! - 收：POST `ilink/bot/getupdates`，body `{get_updates_buf: 游标(首次空串),
//!   base_info:{channel_version}}`，服务器 hold 最长 ~35s；响应
//!   `{ret:0, msgs:[...], get_updates_buf: 新游标}` —— 游标必须回写否则重复收。
//! - 消息：`message_type == 1` 为用户消息；文本在
//!   `item_list[0].text_item.text`；回复必需携带该消息的 `context_token`
//!   与 `from_user_id`。
//! - 发：POST `ilink/bot/sendmessage`，body
//!   `{msg:{to_user_id, message_type:2, message_state:2, context_token,
//!   item_list:[{type:1,text_item:{text}}]}, base_info}`。
//! - 鉴权：`Authorization: Bearer {bot_token}` + `AuthorizationType:
//!   ilink_bot_token` + `X-WECHAT-UIN: base64(随机uint32十进制)`。
//! - 状态经 `wechat-status` `{online, detail}` 上报；消息经 `wechat-message`
//!   推给前端（注入 ReinBot 会话，与 QQ 同一套桥）。

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tauri::Emitter;

const UPDATES_PATH: &str = "ilink/bot/getupdates";
const SEND_PATH: &str = "ilink/bot/sendmessage";
const CHANNEL_VERSION: &str = "1.0.2";
/// getupdates 长轮询服务器 hold 上限 ~35s，客户端超时留余量。
const POLL_TIMEOUT_SECS: u64 = 45;
/// 连续失败退避上限。
const MAX_BACKOFF_SECS: u64 = 60;

fn base_of(base_url: Option<&str>) -> String {
    base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| crate::im_channels::WECHAT_DEFAULT_BASE_URL.to_string())
}

fn ilink_headers(token: &str) -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap, HeaderValue};
    let mut headers = HeaderMap::new();
    headers.insert(
        "AuthorizationType",
        HeaderValue::from_static("ilink_bot_token"),
    );
    let uin = base64::engine::general_purpose::STANDARD
        .encode(crate::im_channels::random_u32().to_string());
    if let Ok(v) = HeaderValue::from_str(&uin) {
        headers.insert("X-WECHAT-UIN", v);
    }
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", token.trim())) {
        headers.insert("Authorization", v);
    }
    headers
}

// ---------------- 消息提取（纯函数，单测覆盖） ----------------

/// 收到的微信用户消息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatIncomingMessage {
    pub from_user_id: String,
    pub content: String,
    /// 回复必需：原样带回 sendmessage 的 context_token。
    pub context_token: String,
}

/// 从 getupdates 的单条 msg 提取用户文本消息（message_type==1，文本项）。
pub fn extract_wechat_message(msg: &Value) -> Option<WechatIncomingMessage> {
    let message_type = msg.get("message_type").and_then(|x| x.as_i64())?;
    if message_type != 1 {
        return None;
    }
    let from_user_id = msg
        .get("from_user_id")
        .and_then(|x| x.as_str())?
        .to_string();
    let context_token = msg
        .get("context_token")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let items = msg.get("item_list")?.as_array()?;
    let content = items
        .iter()
        .filter_map(|item| {
            let ti = item.get("text_item")?;
            ti.get("text").and_then(|x| x.as_str())
        })
        .collect::<Vec<&str>>()
        .join("");
    if content.trim().is_empty() {
        return None;
    }
    Some(WechatIncomingMessage {
        from_user_id,
        content,
        context_token,
    })
}

// ---------------- getupdates / sendmessage ----------------

/// 一次长轮询。返回 (原始 msgs 数组, 新游标)。
async fn getupdates_once(
    base: &str,
    token: &str,
    cursor: &str,
) -> Result<(Value, String), String,> {
    let url = format!("{base}/{UPDATES_PATH}");
    let client = crate::app_proxy::build_proxied_reqwest_client(
        &url,
        Some(Duration::from_secs(10)),
        Some(Duration::from_secs(POLL_TIMEOUT_SECS)),
    )?;
    let body = serde_json::json!({
        "get_updates_buf": cursor,
        "base_info": { "channel_version": CHANNEL_VERSION },
    });
    let resp = client
        .post(&url)
        .headers(ilink_headers(token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("getupdates 请求失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("AUTH:bot_token 无效或已过期，请重新扫码".to_string());
    }
    if !status.is_success() {
        return Err(format!("getupdates HTTP {status}（响应前 200 字：{}）", truncate_str(&text, 200)));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("getupdates 响应解析失败：{e}（原文前 200 字：{}）", truncate_str(&text, 200)))?;
    let ret = v.get("ret").and_then(|x| x.as_i64()).unwrap_or(0);
    if ret != 0 {
        let errmsg = v.get("errmsg").and_then(|x| x.as_str()).unwrap_or("");
        return Err(format!("iLink 返回 ret={ret} {errmsg}"));
    }
    let msgs = v.get("msgs").cloned().unwrap_or(Value::Array(vec![]));
    let new_cursor = v
        .get("get_updates_buf")
        .and_then(|x| x.as_str())
        .unwrap_or(cursor)
        .to_string();
    Ok((msgs, new_cursor))
}

#[derive(Deserialize)]
pub struct WechatSendArgs {
    pub bot_token: String,
    #[serde(default)]
    pub base_url: Option<String>,
    pub to_user_id: String,
    /// 收到消息里的 context_token（被动回复必需）。
    pub context_token: String,
    pub content: String,
}

/// sendmessage 被动回复。
pub async fn wechat_send_message(args: &WechatSendArgs) -> Result<(), String> {
    if args.to_user_id.trim().is_empty() {
        return Err("回复目标 from_user_id 为空".to_string());
    }
    if args.content.trim().is_empty() {
        return Err("回复内容为空".to_string());
    }
    let base = base_of(args.base_url.as_deref());
    let url = format!("{base}/{SEND_PATH}");
    let client = crate::app_proxy::build_proxied_reqwest_client(
        &url,
        Some(Duration::from_secs(10)),
        Some(Duration::from_secs(20)),
    )?;
    let body = serde_json::json!({
        "msg": {
            "from_user_id": "",
            "to_user_id": args.to_user_id.trim(),
            // client_id（客户端生成的唯一消息 ID）缺失时腾讯收下但不投递（2026-11-01 实测踩坑）
            "client_id": format!(
                "reinagent-weixin:{}-{:08x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0),
                crate::im_channels::random_u32()
            ),
            "message_type": 2,
            "message_state": 2,
            "context_token": args.context_token,
            "item_list": [{ "type": 1, "text_item": { "text": args.content } }],
        },
        "base_info": { "channel_version": CHANNEL_VERSION },
    });
    let resp = client
        .post(&url)
        .headers(ilink_headers(&args.bot_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("发送微信消息失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("AUTH:bot_token 无效或已过期，请重新扫码".to_string());
    }
    if !status.is_success() {
        return Err(format!("HTTP {status}（响应前 300 字：{}）", truncate_str(&text, 300)));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("sendmessage 响应解析失败：{e}（原文前 300 字：{}）", truncate_str(&text, 300)))?;
    let ret = v.get("ret").and_then(|x| x.as_i64()).unwrap_or(0);
    if ret != 0 {
        let errmsg = v.get("errmsg").and_then(|x| x.as_str()).unwrap_or("");
        return Err(format!("iLink 返回 ret={ret} {errmsg}"));
    }
    Ok(())
}

fn truncate_str(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let cut: String = s.chars().take(n).collect();
        format!("{cut}…")
    }
}

// ---------------- 网关运行时 ----------------

static WECHAT_ONLINE: AtomicBool = AtomicBool::new(false);
static WECHAT_HANDLE: StdMutex<Option<tauri::async_runtime::JoinHandle<()>>> = StdMutex::new(None);
static WECHAT_SHUTDOWN_TX: StdMutex<Option<tokio::sync::watch::Sender<bool>>> = StdMutex::new(None);

pub type EventSink = std::sync::Arc<dyn Fn(&str, Value) + Send + Sync>;

pub fn wechat_gateway_online() -> bool {
    WECHAT_ONLINE.load(Ordering::Relaxed)
}

fn emit_status(sink: &EventSink, online: bool, detail: &str) {
    WECHAT_ONLINE.store(online, Ordering::Relaxed);
    sink("wechat-status", serde_json::json!({ "online": online, "detail": detail }));
}

/// 网关主循环：getupdates 长轮询（游标续传）→ 提取用户文本消息 → 推给前端。
pub async fn wechat_gateway_loop(
    bot_token: String,
    base_url: Option<String>,
    sink: EventSink,
    shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let mut shutdown = shutdown;
    let base = base_of(base_url.as_deref());
    let mut cursor = String::new();
    let mut backoff_secs = 2u64;

    loop {
        if *shutdown.borrow() {
            break;
        }
        match getupdates_once(&base, &bot_token, &cursor).await {
            Ok((msgs, new_cursor)) => {
                if !WECHAT_ONLINE.load(Ordering::Relaxed) {
                    emit_status(&sink, true, "网关在线");
                }
                backoff_secs = 2;
                cursor = new_cursor;
                if let Some(arr) = msgs.as_array() {
                    for msg in arr {
                        if let Some(m) = extract_wechat_message(msg) {
                            sink(
                                "wechat-message",
                                serde_json::to_value(&m).unwrap_or(Value::Null),
                            );
                        }
                    }
                }
            }
            Err(e) => {
                let auth_fail = e.starts_with("AUTH:");
                let detail = e.strip_prefix("AUTH:").unwrap_or(&e).to_string();
                eprintln!("[wechat-gateway] {detail}");
                emit_status(&sink, false, &detail);
                if auth_fail {
                    // token 失效：重试无意义，停止网关等用户重新扫码
                    break;
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => {}
                    _ = shutdown.changed() => { break; }
                }
                backoff_secs = (backoff_secs * 2).min(MAX_BACKOFF_SECS);
                continue;
            }
        }
    }
    emit_status(&sink, false, "网关未运行");
}

// ---------------- Tauri 命令 ----------------

#[derive(Deserialize)]
pub struct WechatGatewayStartArgs {
    pub bot_token: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

#[tauri::command]
pub async fn wechat_gateway_start(
    app: tauri::AppHandle,
    args: WechatGatewayStartArgs,
) -> Result<(), String> {
    let _ = wechat_gateway_stop(app.clone()).await;
    if args.bot_token.trim().is_empty() {
        return Err("bot_token 为空，请先扫码登录".to_string());
    }
    let (tx, rx) = tokio::sync::watch::channel(false);
    if let Ok(mut g) = WECHAT_SHUTDOWN_TX.lock() {
        *g = Some(tx);
    }
    let sink: EventSink = std::sync::Arc::new(move |event: &str, payload: Value| {
        let _ = app.emit(event, payload);
    });
    let handle = tauri::async_runtime::spawn(wechat_gateway_loop(
        args.bot_token.trim().to_string(),
        args.base_url.clone(),
        sink,
        rx,
    ));
    if let Ok(mut g) = WECHAT_HANDLE.lock() {
        *g = Some(handle);
    }
    Ok(())
}

#[tauri::command]
pub async fn wechat_gateway_stop(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(mut tx) = WECHAT_SHUTDOWN_TX.lock() {
        if let Some(t) = tx.take() {
            let _ = t.send(true);
        }
    }
    if let Ok(mut g) = WECHAT_HANDLE.lock() {
        if let Some(h) = g.take() {
            h.abort();
        }
    }
    WECHAT_ONLINE.store(false, Ordering::Relaxed);
    let _ = app.emit("wechat-status", serde_json::json!({ "online": false, "detail": "网关已停止" }));
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatGatewayStatus {
    pub online: bool,
}

#[tauri::command]
pub async fn wechat_gateway_status() -> WechatGatewayStatus {
    WechatGatewayStatus { online: wechat_gateway_online() }
}

#[tauri::command]
pub async fn im_wechat_send(args: WechatSendArgs) -> Result<(), String> {
    wechat_send_message(&args).await
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 消息提取：message_type 过滤 + 文本拼接 + 空文本拒绝。Red Check 敏感点。
    #[test]
    fn wechat_message_extraction() {
        let msg = serde_json::json!({
            "message_type": 1,
            "from_user_id": "user-abc",
            "context_token": "ctx-1",
            "item_list": [{ "type": 1, "text_item": { "text": "你好微信" } }],
        });
        let m = extract_wechat_message(&msg).expect("用户文本消息应可提取");
        assert_eq!(m.from_user_id, "user-abc");
        assert_eq!(m.content, "你好微信");
        assert_eq!(m.context_token, "ctx-1");

        // 非 text_item 的项忽略，多段拼接
        let multi = serde_json::json!({
            "message_type": 1,
            "from_user_id": "u",
            "context_token": "c",
            "item_list": [
                { "type": 1, "text_item": { "text": "第一段" } },
                { "type": 2, "pic_item": {} },
                { "type": 1, "text_item": { "text": "第二段" } },
            ],
        });
        assert_eq!(extract_wechat_message(&multi).unwrap().content, "第一段第二段");

        // message_type != 1（如系统/自身消息）不提取
        assert!(extract_wechat_message(&serde_json::json!({
            "message_type": 2, "from_user_id": "u", "context_token": "c",
            "item_list": [{ "type": 1, "text_item": { "text": "x" } }],
        })).is_none());
        // 空文本不提取
        assert!(extract_wechat_message(&serde_json::json!({
            "message_type": 1, "from_user_id": "u", "context_token": "c",
            "item_list": [{ "type": 1, "text_item": { "text": "  " } }],
        })).is_none());
    }

    /// 真实 TCP 全链路：sendmessage 校验 Bearer 头与被动回复 body 形态。
    #[tokio::test]
    async fn wechat_send_over_real_tcp() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = vec![0u8; 65536];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let lower = req.to_ascii_lowercase();
                assert!(lower.contains("post /ilink/bot/sendmessage"), "{req}");
                assert!(lower.contains("authorization: bearer e2e-wx-token"), "应带 Bearer：{req}");
                assert!(lower.contains("to_user_id"), "body 应含 to_user_id");
                assert!(lower.contains("context_token"), "body 应含 context_token");
                assert!(lower.contains("client_id"), "body 必须含 client_id（缺失不投递）：{req}");
                assert!(lower.contains("你好"), "body 应含回复文本");
                let body = r#"{"ret":0}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        wechat_send_message(&WechatSendArgs {
            bot_token: "e2e-wx-token".to_string(),
            base_url: Some(format!("http://127.0.0.1:{port}")),
            to_user_id: "user-1".to_string(),
            context_token: "ctx-9".to_string(),
            content: "你好，这是回复".to_string(),
        })
        .await
        .expect("真实 TCP sendmessage 应成功");
    }

    /// 失败路径：ret != 0 如实报错。
    #[tokio::test]
    async fn wechat_send_reports_error() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                use std::io::{Read, Write};
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut buf = vec![0u8; 65536];
                    let _ = stream.read(&mut buf);
                    let body = r#"{"ret":1001,"errmsg":"rate limit"}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    let _ = stream.write_all(resp.as_bytes());
                }
            });
            port
        };
        let err = wechat_send_message(&WechatSendArgs {
            bot_token: "t".to_string(),
            base_url: Some(format!("http://127.0.0.1:{port}")),
            to_user_id: "u".to_string(),
            context_token: "c".to_string(),
            content: "x".to_string(),
        })
        .await
        .expect_err("ret!=0 必须报错");
        assert!(err.contains("1001") && err.contains("rate limit"), "{err}");
    }
}
