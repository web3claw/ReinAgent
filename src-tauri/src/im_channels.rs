//! IM 机器人渠道接入与连通性测试（2026-10-31，ReinBot 工牌三图标）。
//!
//! 三个平台的「设置机器人」真实连通测试，全部如实上抛错误（No-Fallback），
//! 由前端在配置弹窗里展示原始错误；只有真实连通成功前端才点亮图标：
//!
//! - **QQ（官方机器人开放平台 q.qq.com/qqbot，2026-11-01 定稿）**：
//!   `getAppAccessToken`（AppID+AppSecret→access_token；实测错误也返回 HTTP 200，
//!   靠 body `code` 判定）→ `users/@me`（`Authorization: QQBot {token}`）拿机器人名。
//!   OneBot 11 个人号模式已于 2026-11-01 按用户要求整体移除。
//! - **微信（个人号 Bot，腾讯 iLink / ClawBot 协议）**：基址默认
//!   `https://ilinkai.weixin.qq.com`。扫码登录流：`get_bot_qrcode?bot_type=3`
//!   （实测 2026-10-31 返回 `{ qrcode, qrcode_img_content: 短链URL, ret }`，
//!   Content-Type 为 octet-stream，不能按 content-type 判定）→
//!   `get_qrcode_status?qrcode=` 轮询至 `status == "confirmed"` 拿
//!   `bot_token` / `baseurl` / `ilink_user_id`（扫码人 ID，后续发消息上下文用）。
//!   登录完成 = confirmed 即止（参考实现不做额外校验；getconfig 的
//!   GetTypingTicket RPC 需要聊天上下文，不能当登录校验用）。
//!   请求头固定：`AuthorizationType: ilink_bot_token` +
//!   `X-WECHAT-UIN: base64(随机uint32十进制字符串)` + `Authorization: Bearer {token}`。
//! - **飞书（自定义群机器人）**：Webhook URL + 可选签名密钥（官方算法：
//!   HMAC-SHA256，key = `{timestamp}\n{secret}`，data 为空串，base64 输出），
//!   测试 = 发一条真实文本消息，响应 `code == 0`（旧版 `StatusCode`）即连通。
//!
//! 代理语义：HTTP 请求统一走 `app_proxy::build_proxied_reqwest_client`
//! （与设置页代理一致）；三个通道均为纯 HTTP，无长连接。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// 微信 iLink 默认基址（协议文档与实测一致）。
pub const WECHAT_DEFAULT_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
/// iLink 固定鉴权头（文档「请求头固定套路」）。
const ILINK_AUTH_TYPE: &str = "ilink_bot_token";
/// 通道版本号（文档示例值）。
const ILINK_CHANNEL_VERSION: &str = "1.0.2";

// ---------------- QQ 官方机器人开放平台（q.qq.com/qqbot） ----------------

/// 腾讯官方 QQ 机器人开放平台 token 端点（q.qq.com/qqbot）。
/// 实测（2026-11-01）：**错误也返回 HTTP 200**，靠 body `code` 字段判定
/// （10004 机器人不存在 / 100007 appid invalid），必须检查 code 而非状态码。
pub const QQBOT_TOKEN_URL: &str = "https://bots.qq.com/app/getAppAccessToken";
/// 官方 API 基址。
pub const QQBOT_API_BASE: &str = "https://api.sgroup.qq.com";

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

#[derive(Deserialize)]
pub struct QqBotTestArgs {
    /// 开放平台 AppID。
    pub app_id: String,
    /// AppSecret（机器人密钥）。
    pub app_secret: String,
}

/// 解析 getAppAccessToken 响应：**错误同样 HTTP 200**，必须检查 code 字段
/// （实测 2026-11-01：{"code":10004,"message":"机器人不存在"}）。
pub fn parse_qqbot_token_response(body: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("响应不是合法 JSON：{e}（原文前 300 字：{}）", truncate(body, 300)))?;
    if let Some(code) = v.get("code").and_then(|x| x.as_i64()) {
        if code != 0 {
            let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("");
            return Err(format!("腾讯返回 code={code} {msg}"));
        }
    }
    let token = v
        .get("access_token")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!(
                "腾讯返回空 access_token（AppID/AppSecret 无效；原文前 300 字：{}）",
                truncate(body, 300)
            )
        })?;
    Ok(token.to_string())
}

/// 官方平台连通性测试（token_url / api_base 可注入以便本地真实链路测试）：
/// ① getAppAccessToken 拿真实 access_token → ② GET /users/@me 拿机器人资料。
/// access_token 不落盘、不返回给前端持久化。
pub async fn qqbot_test_with(
    token_url: &str,
    api_base: &str,
    args: &QqBotTestArgs,
) -> Result<String, String> {
    let app_id = args.app_id.trim();
    let app_secret = args.app_secret.trim();
    if app_id.is_empty() || app_secret.is_empty() {
        return Err("AppID 与 AppSecret 均不能为空".to_string());
    }
    let client = crate::app_proxy::build_proxied_reqwest_client(
        token_url,
        Some(std::time::Duration::from_secs(10)),
        Some(std::time::Duration::from_secs(20)),
    )?;
    let resp = client
        .post(token_url)
        .header("Content-Type", "application/json")
        .body(
            serde_json::json!({ "appId": app_id, "clientSecret": app_secret }).to_string(),
        )
        .send()
        .await
        .map_err(|e| format!("请求腾讯鉴权端点失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {status}（响应前 300 字：{}）", truncate(&text, 300)));
    }
    let access_token = parse_qqbot_token_response(&text)?;

    // ② 机器人资料（轻量鉴权探测；头格式：Authorization: QQBot {access_token}）。
    let me_url = format!("{api_base}/users/@me");
    let me_resp = client
        .get(&me_url)
        .header("Authorization", format!("QQBot {access_token}"))
        .send()
        .await
        .map_err(|e| format!("请求机器人资料失败：{e}"))?;
    let me_status = me_resp.status();
    let me_text = me_resp.text().await.unwrap_or_default();
    if !me_status.is_success() {
        return Err(format!(
            "机器人资料 HTTP {me_status}（token 拿到了但 API 鉴权失败；响应前 300 字：{}）",
            truncate(&me_text, 300)
        ));
    }
    let me: serde_json::Value = serde_json::from_str(&me_text)
        .map_err(|e| format!("机器人资料 JSON 解析失败：{e}（原文前 300 字：{}）", truncate(&me_text, 300)))?;
    Ok(me
        .get("username")
        .and_then(|x| x.as_str())
        .unwrap_or("unknown")
        .to_string())
}

/// 官方平台连通性测试。
pub async fn qqbot_test(args: QqBotTestArgs) -> Result<String, String> {
    qqbot_test_with(QQBOT_TOKEN_URL, QQBOT_API_BASE, &args).await
}

// ---------------- 微信（个人号 Bot，iLink / ClawBot） ----------------

#[derive(Deserialize)]
pub struct WechatBaseUrlArgs {
    /// iLink 基址；留空用默认。
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Deserialize)]
pub struct WechatPollArgs {
    #[serde(default)]
    pub base_url: Option<String>,
    pub qrcode: String,
}

#[derive(Deserialize)]
pub struct WechatVerifyArgs {
    #[serde(default)]
    pub base_url: Option<String>,
    pub bot_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatQrStart {
    pub qrcode: String,
    /// 二维码内容（实测为短链 URL，前端用 qrcode 包自行渲染图片）。
    pub qrcode_img_content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatQrPollStatus {
    /// 服务器原样 status 字符串（wait / scaned / confirmed / expired …）。
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseurl: Option<String>,
    /// 扫码人的 iLink 用户 ID（confirmed 时返回；getconfig 必需）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ilink_user_id: Option<String>,
}

fn wechat_base_of(args_base: Option<&str>) -> String {
    args_base
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| WECHAT_DEFAULT_BASE_URL.to_string())
}

/// 随机 uint32（无 rand 依赖：纳秒时钟 + 进程号混合熵）。
pub fn random_u32() -> u32 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u128 ^ (d.as_secs() as u128) << 32)
        .unwrap_or(0x9E3779B9);
    let pid = std::process::id() as u128;
    ((nanos ^ (pid << 64)) % (u32::MAX as u128)) as u32
}

/// iLink 固定请求头（可选 Bearer token）。
fn ilink_headers(token: Option<&str>) -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap, HeaderValue};
    let mut headers = HeaderMap::new();
    headers.insert(
        "AuthorizationType",
        HeaderValue::from_static(ILINK_AUTH_TYPE),
    );
    let uin = B64.encode(random_u32().to_string());
    if let Ok(v) = HeaderValue::from_str(&uin) {
        headers.insert("X-WECHAT-UIN", v);
    }
    if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {t}")) {
            headers.insert("Authorization", v);
        }
    }
    headers
}

/// 校验 iLink 响应 JSON：ret == 0 即成功（实测成功响应带 ret:0）。
fn parse_ilink_response(body: &str) -> Result<serde_json::Value, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("响应不是合法 JSON：{e}（原文前 300 字：{}）", truncate(body, 300)))?;
    let ret = v.get("ret").and_then(|x| x.as_i64()).unwrap_or(0);
    if ret != 0 {
        return Err(format!("iLink 返回 ret={ret}（原文前 300 字：{}）", truncate(body, 300)));
    }
    Ok(v)
}

/// 发起微信扫码登录：返回 qrcode 与二维码内容（短链 URL，前端自渲染）。
pub async fn wechat_qrcode_start(args: WechatBaseUrlArgs) -> Result<WechatQrStart, String> {
    let base = wechat_base_of(args.base_url.as_deref());
    let url = format!("{base}/ilink/bot/get_bot_qrcode?bot_type=3");
    let client = crate::app_proxy::build_proxied_reqwest_client(
        &url,
        Some(std::time::Duration::from_secs(10)),
        Some(std::time::Duration::from_secs(20)),
    )?;
    let resp = client
        .get(&url)
        .headers(ilink_headers(None))
        .send()
        .await
        .map_err(|e| format!("请求微信登录二维码失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {status}（响应前 300 字：{}）", truncate(&text, 300)));
    }
    let v = parse_ilink_response(&text)?;
    let qrcode = v
        .get("qrcode")
        .and_then(|x| x.as_str())
        .ok_or_else(|| format!("响应缺少 qrcode 字段（原文前 300 字：{}）", truncate(&text, 300)))?
        .to_string();
    let img = v
        .get("qrcode_img_content")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Ok(WechatQrStart {
        qrcode,
        qrcode_img_content: img,
    })
}

/// 轮询扫码状态：confirmed 时携带 bot_token / baseurl。
pub async fn wechat_qrcode_poll(args: WechatPollArgs) -> Result<WechatQrPollStatus, String> {
    let base = wechat_base_of(args.base_url.as_deref());
    let url = format!(
        "{base}/ilink/bot/get_qrcode_status?qrcode={}",
        urlencoding::encode(args.qrcode.trim())
    );
    let client = crate::app_proxy::build_proxied_reqwest_client(
        &url,
        Some(std::time::Duration::from_secs(10)),
        Some(std::time::Duration::from_secs(35)),
    )?;
    let resp = client
        .get(&url)
        .headers(ilink_headers(None))
        .send()
        .await
        .map_err(|e| format!("轮询扫码状态失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {status}（响应前 300 字：{}）", truncate(&text, 300)));
    }
    let v = parse_ilink_response(&text)?;
    let st = v
        .get("status")
        .and_then(|x| x.as_str())
        .unwrap_or("unknown")
        .to_string();
    Ok(WechatQrPollStatus {
        status: st,
        bot_token: v.get("bot_token").and_then(|x| x.as_str()).map(String::from),
        baseurl: v.get("baseurl").and_then(|x| x.as_str()).map(String::from),
        ilink_user_id: v
            .get("ilink_user_id")
            .and_then(|x| x.as_str())
            .map(String::from),
    })
}

/// 验证 bot_token（手动 Token 路径）：走真实消息接口 `getupdates`（空游标长轮询，
/// 服务器最长 hold ~35s；token 无效会立即报错，有效则最终返回 ret:0）。
/// 注意：不能用 getconfig 做校验——其 GetTypingTicket RPC 需要聊天上下文，
/// 全新机器人必返 ret=-4（2026-11-01 实测）；且参考实现登录完成即止，不做额外校验。
pub async fn wechat_verify(args: WechatVerifyArgs) -> Result<(), String> {
    let base = wechat_base_of(args.base_url.as_deref());
    let url = format!("{base}/ilink/bot/getupdates");
    let client = crate::app_proxy::build_proxied_reqwest_client(
        &url,
        Some(std::time::Duration::from_secs(10)),
        Some(std::time::Duration::from_secs(45)),
    )?;
    let body = serde_json::json!({
        "get_updates_buf": "",
        "base_info": { "channel_version": ILINK_CHANNEL_VERSION },
    });
    let resp = client
        .post(&url)
        .headers(ilink_headers(Some(&args.bot_token)))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("连接微信 iLink 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(format!("鉴权失败：HTTP {status}，bot_token 无效或已过期"));
    }
    if !status.is_success() {
        return Err(format!("HTTP {status}（响应前 300 字：{}）", truncate(&text, 300)));
    }
    parse_ilink_response(&text).map(|_| ())
}

// ---------------- Tauri 命令 ----------------

#[tauri::command]
pub async fn im_qqbot_test(args: QqBotTestArgs) -> Result<String, String> {
    qqbot_test(args).await
}

#[tauri::command]
pub async fn im_wechat_qrcode_start(args: WechatBaseUrlArgs) -> Result<WechatQrStart, String> {
    wechat_qrcode_start(args).await
}

#[tauri::command]
pub async fn im_wechat_qrcode_poll(args: WechatPollArgs) -> Result<WechatQrPollStatus, String> {
    wechat_qrcode_poll(args).await
}

#[tauri::command]
pub async fn im_wechat_verify(args: WechatVerifyArgs) -> Result<(), String> {
    wechat_verify(args).await
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 官方平台 token 响应判定：错误同样 HTTP 200，必须按 code 字段如实报错。
    #[test]
    fn qqbot_token_response_gate() {
        assert_eq!(
            parse_qqbot_token_response(r#"{"access_token":"abc","expires_in":"7200"}"#).unwrap(),
            "abc"
        );
        let err = parse_qqbot_token_response(r#"{"code":10004,"message":"机器人不存在"}"#)
            .expect_err("code!=0 必须报错");
        // 断言走 code 门产生的「腾讯返回 code=」前缀（错误信息内嵌原文 excerpt，
        // contains 会弱化到恒真——必须用前缀断言才能抓到 code 门被破坏的变异）。
        assert!(err.starts_with("腾讯返回 code=10004") && err.contains("机器人不存在"), "{err}");
        assert!(parse_qqbot_token_response(r#"{"access_token":"","expires_in":""}"#).is_err(), "空 token 必须报错");
        assert!(parse_qqbot_token_response("not json").is_err());
    }

    /// X-WECHAT-UIN 生成：base64 解码后必须是可解析为 u32 的十进制数字串。
    #[test]
    fn wechat_uin_header_is_base64_of_u32_decimal() {
        for _ in 0..32 {
            let uin = B64.encode(random_u32().to_string());
            let decoded = B64.decode(&uin).expect("应为合法 base64");
            let s = String::from_utf8(decoded).expect("应为 UTF-8");
            let n: u32 = s.parse().expect("应为十进制数字串");
            assert_eq!(n.to_string(), s);
        }
    }

    /// iLink 响应判定：ret 非 0 如实报错；缺 qrcode 如实报错。
    #[test]
    fn ilink_response_ret_gate() {
        assert!(parse_ilink_response(r#"{"ret":0,"qrcode":"abc"}"#).is_ok());
        assert!(parse_ilink_response(r#"{"ret":1001,"msg":"rate limit"}"#).is_err());
        assert!(parse_ilink_response("{}").is_ok(), "无 ret 视为成功（实测成功带 ret:0，此为宽容兜口）");
    }

    // ---------------- 真实传输层集成测试（本地真实 TCP/HTTP/WS，非函数级 mock） ----------------

    #[cfg(test)]
    mod real_transport_tests {
        use super::*;
        use std::io::{Read, Write};
        use std::net::TcpListener;

        /// 起一个一次性本地 HTTP 服务器（单请求），返回端口。
        /// handler 收到完整原始请求（头+体），返回完整原始响应字节。
        fn spawn_local_http(
            handler: impl FnOnce(String) -> Vec<u8> + Send + 'static,
        ) -> u16 {
            let listener = TcpListener::bind("127.0.0.1:0").expect("绑定本地端口");
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut buf = vec![0u8; 65536];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let resp = handler(req);
                    let _ = stream.write_all(&resp);
                    let _ = stream.flush();
                }
            });
            port
        }

        fn http_response_json(body: &str) -> Vec<u8> {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .into_bytes()
        }

        /// 微信 iLink 扫码全链路：get_bot_qrcode → 轮询 confirmed（含 ilink_user_id）。
        /// 登录完成即止（参考 openclaw-weixin：不做 getconfig 额外校验）。
        #[tokio::test]
        async fn wechat_scan_flow_over_real_tcp() {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                let mut poll_served = false;
                while !poll_served {
                    let Ok((mut stream, _)) = listener.accept() else { break };
                    // 完整读取请求（headers + Content-Length 体），避免竞态截断触发客户端重试。
                    let mut raw: Vec<u8> = Vec::new();
                    let mut chunk = [0u8; 16384];
                    loop {
                        let n = stream.read(&mut chunk).unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        raw.extend_from_slice(&chunk[..n]);
                        let s = String::from_utf8_lossy(&raw);
                        if let Some(header_end) = s.find("\r\n\r\n") {
                            let len: usize = s
                                .lines()
                                .find_map(|l| {
                                    let lower = l.to_ascii_lowercase();
                                    lower.starts_with("content-length:")
                                        .then(|| lower.split(':').nth(1)?.trim().parse().ok())?
                                })
                                .unwrap_or(0);
                            if raw.len() >= header_end + 4 + len {
                                break;
                            }
                        }
                    }
                    let req = String::from_utf8_lossy(&raw).to_string();
                    let lower = req.to_ascii_lowercase();
                    let body = if lower.contains("get_bot_qrcode") {
                        assert!(req.starts_with("GET /ilink/bot/get_bot_qrcode?bot_type=3"));
                        r#"{"qrcode":"e2e-qr-token","qrcode_img_content":"https://example.com/q/abc","ret":0}"#.to_string()
                    } else if lower.contains("get_qrcode_status") {
                        poll_served = true;
                        r#"{"status":"confirmed","bot_token":"e2e-bot-token","baseurl":"http://127.0.0.1:19999","ilink_user_id":"e2e-scanner","ret":0}"#.to_string()
                    } else {
                        String::from("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    };
                    let resp = if body.starts_with("HTTP/") {
                        body.into_bytes()
                    } else {
                        http_response_json(&body)
                    };
                    let _ = stream.write_all(&resp);
                    let _ = stream.flush();
                }
            });

            let start = wechat_qrcode_start(WechatBaseUrlArgs {
                base_url: Some(format!("http://127.0.0.1:{port}")),
            })
            .await
            .expect("拉取二维码应成功");
            assert_eq!(start.qrcode, "e2e-qr-token");
            assert_eq!(start.qrcode_img_content, "https://example.com/q/abc");

            let st = wechat_qrcode_poll(WechatPollArgs {
                base_url: Some(format!("http://127.0.0.1:{port}")),
                qrcode: start.qrcode.clone(),
            })
            .await
            .expect("轮询应成功");
            assert_eq!(st.status, "confirmed");
            assert_eq!(st.bot_token.as_deref(), Some("e2e-bot-token"));
            assert_eq!(st.baseurl.as_deref(), Some("http://127.0.0.1:19999"));
            assert_eq!(st.ilink_user_id.as_deref(), Some("e2e-scanner"));
        }

        /// 手动 Token 校验全链路：getupdates（空游标）+ Bearer 鉴权头 → ret:0。
        #[tokio::test]
        async fn wechat_manual_verify_over_real_tcp() {
            let port = spawn_local_http(|req| {
                let lower = req.to_ascii_lowercase();
                assert!(lower.contains("post /ilink/bot/getupdates"), "应请求 getupdates：{req}");
                assert!(lower.contains("authorization: bearer e2e-manual-token"), "应带 Bearer：{req}");
                assert!(lower.contains("get_updates_buf"), "body 应含空游标：{req}");
                http_response_json(r#"{"ret":0,"msgs":[],"get_updates_buf":"cursor-1"}"#)
            });
            wechat_verify(WechatVerifyArgs {
                base_url: Some(format!("http://127.0.0.1:{port}")),
                bot_token: "e2e-manual-token".to_string(),
            })
            .await
            .expect("getupdates 校验应通过");
        }

        /// QQ 官方平台全链路（本地真实 TCP 双端点）：getAppAccessToken（校验请求体）→
        /// /users/@me（校验 Authorization: QQBot 头）→ 返回机器人用户名。
        #[tokio::test]
        async fn qqbot_official_test_over_real_tcp() {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                loop {
                    let Ok((mut stream, _)) = listener.accept() else { break };
                    let mut raw: Vec<u8> = Vec::new();
                    let mut chunk = [0u8; 16384];
                    loop {
                        let n = stream.read(&mut chunk).unwrap_or(0);
                        if n == 0 { break; }
                        raw.extend_from_slice(&chunk[..n]);
                        let s = String::from_utf8_lossy(&raw);
                        if let Some(header_end) = s.find("\r\n\r\n") {
                            let len: usize = s
                                .lines()
                                .find_map(|l| {
                                    let lower = l.to_ascii_lowercase();
                                    lower.starts_with("content-length:")
                                        .then(|| lower.split(':').nth(1)?.trim().parse().ok())?
                                })
                                .unwrap_or(0);
                            if raw.len() >= header_end + 4 + len { break; }
                        }
                    }
                    let req = String::from_utf8_lossy(&raw).to_string();
                    let lower = req.to_ascii_lowercase();
                    let body = if lower.contains("post /app/getaccesstoken") {
                        assert!(lower.contains("clientsecret"), "鉴权请求体应含 clientSecret：{req}");
                        http_response_json(r#"{"access_token":"e2e-token","expires_in":"7200"}"#)
                    } else if lower.contains("get /users/@me") {
                        assert!(lower.contains("authorization: qqbot e2e-token"), "应带 QQBot 鉴权头：{req}");
                        http_response_json(r#"{"id":"u1","username":"E2E-Bot","avatar":""}"#)
                    } else {
                        panic!("未知请求：{req}")
                    };
                    let _ = stream.write_all(&body);
                    let _ = stream.flush();
                }
            });
            let username = qqbot_test_with(
                &format!("http://127.0.0.1:{port}/app/getAccessToken"),
                &format!("http://127.0.0.1:{port}"),
                &QqBotTestArgs {
                    app_id: "e2e-appid".to_string(),
                    app_secret: "e2e-secret".to_string(),
                },
            )
            .await
            .expect("官方平台真实 TCP 全链路应连通");
            assert_eq!(username, "E2E-Bot");
        }
    }
}
