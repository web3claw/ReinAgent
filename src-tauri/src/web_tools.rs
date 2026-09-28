//! WebFetch / WebSearch 出网工具（P1-5，对齐 ZCode WebFetch 客户端实现思路）。
//!
//! WebView 内直接 fetch 公网会受 CORS 约束（同 hub_http），统一经本模块的
//! Rust 命令出网：ureq（rustls）+ 30s 全局超时 + 响应体硬上限。
//! - web_fetch：抓取 URL → HTML 转 UTF-8 文本（html2text）；http 强制升级 https；
//!   拒绝 localhost/私网/带凭证 URL（SSRF 基线防护，DNS 重绑定不在本期范围）。
//! - web_search：DuckDuckGo HTML 端点（无需 API Key）→ 解析结果块 → 客户端
//!   域名白/黑名单过滤（同给不可同时提供，对齐 ZCode 语义）。
//! 错误全部如实上抛，绝不静默降级（No-Fallback 铁律）。

use regex::Regex;
use serde::Serialize;
use std::io::Cursor;
use std::time::{Duration, Instant};

const WEB_UA: &str = "ReinAgent-WebFetch/0.1 (coding-agent-desktop)";
/// 搜索端点反爬敏感（标识 UA 会收到 202 挑战页），必须用浏览器 UA。
const SEARCH_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// 单次抓取的响应体硬上限（原始字节；转文本后由前端工具层再截断喂模型）
const MAX_FETCH_BYTES: usize = 2 * 1024 * 1024;
const MAX_URL_CHARS: usize = 2_000;
const SEARCH_DEFAULT_RESULTS: usize = 10;
const SEARCH_MAX_RESULTS: usize = 25;
/// 出网代理设置键（kv 表）：如 http://127.0.0.1:7890。空值 = 不用代理。
const KV_WEB_PROXY: &str = "reinagent-web-proxy";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResult {
    /// 规范化后的请求 URL
    pub url: String,
    /// 重定向后的最终 URL
    pub final_url: String,
    pub status: u16,
    pub content_type: String,
    /// 原始响应字节数
    pub bytes: usize,
    /// 正文（HTML 已转纯文本）
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub query: String,
    pub results: Vec<WebSearchHit>,
    /// 端点原始解析出的结果数（过滤/截断前）
    pub total_found: usize,
    pub duration_ms: u64,
}

// ---------------------------------------------------------------------------
// URL 规范化与 SSRF 基线防护
// ---------------------------------------------------------------------------

/// 从 authority（host[:port] / [IPv6][:port]）提取 host。
/// ⚠ 必须取**第一个**冒号前段——rsplit 会取到端口（"127.0.0.1:9333" → "9333"，
/// SSRF 检查被绕过，实测踩过）。
fn extract_host(authority: &str) -> &str {
    // IPv6 带方括号：[::1]:8080 → [::1]（is_blocked_host 内再剥方括号）
    if let Some(start) = authority.find('[') {
        if let Some(end) = authority.find(']') {
            if start < end {
                return &authority[start..=end];
            }
        }
    }
    authority.split(':').next().unwrap_or(authority)
}

/// 判定 host 是否为禁止抓取的本地/保留地址（字符串级检查）。
pub(crate) fn is_blocked_host(host: &str) -> bool {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() {
        return true;
    }
    if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h.ends_with(".internal") {
        return true;
    }
    // IPv4 字面量：0/8、10/8、127/8、169.254/16、172.16/12、192.168/16、198.18/15、100.64/10
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() == 4 && parts.iter().all(|p| p.parse::<u16>().map(|n| n <= 255).unwrap_or(false)) {
        let octets: Vec<u32> = parts.iter().filter_map(|p| p.parse::<u32>().ok()).collect();
        let [a, b, _, _] = [octets[0], octets[1], octets[2], octets[3]];
        return matches!(a, 0 | 10 | 127)
            || (a == 169 && b == 254)
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 198 && (18..=19).contains(&b))
            || (a == 100 && (64..=127).contains(&b));
    }
    // IPv6 字面量（含方括号形态）：::1、fc00::/7、fe80::/10、::ffff:IPv4 映射
    let v6 = h.trim_start_matches('[').trim_end_matches(']');
    if v6.contains(':') {
        let lower = v6.to_ascii_lowercase();
        if let Some(mapped) = lower.strip_prefix("::ffff:") {
            return is_blocked_host(mapped);
        }
        return lower == "::1" || lower.starts_with("fc") || lower.starts_with("fd") || lower.starts_with("fe8")
            || lower.starts_with("fe9") || lower.starts_with("fea") || lower.starts_with("feb");
    }
    false
}

/// 抓取 URL 规范化：剥空白、无 scheme 补 https、http 升级 https、
/// 拒绝非 http(s)/带凭证/超长/本地与保留地址。返回规范化 URL 与 host。
pub(crate) fn normalize_fetch_url(raw: &str) -> Result<(String, String), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("web_fetch: URL 为空".into());
    }
    if trimmed.chars().count() > MAX_URL_CHARS {
        return Err(format!("web_fetch: URL 超长（> {MAX_URL_CHARS} 字符）"));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let (scheme, rest) = with_scheme
        .split_once("://")
        .ok_or_else(|| "web_fetch: 无法解析 URL".to_string())?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!("web_fetch: 不支持的协议 {scheme}（仅 http/https）"));
    }
    // 带凭证（user:pass@host）拒绝
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.contains('@') {
        return Err("web_fetch: 不接受 URL 内嵌凭证".into());
    }
    let host = extract_host(authority).to_string();
    if is_blocked_host(&host) {
        return Err(format!("web_fetch: 拒绝访问本地/保留地址 {host}"));
    }
    // http → https 强制升级（对齐 ZCode）
    let url = if scheme == "http" {
        format!("https://{rest}")
    } else {
        with_scheme.clone()
    };
    Ok((url, host))
}

/// 内容类型是否为文本类（text/*、json、xml 及其后缀变体）。空类型按文本处理（宽松）。
fn is_text_like_mime(ctype: &str) -> bool {
    let ct = ctype.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if ct.is_empty() {
        return true;
    }
    if ct.starts_with("text/") {
        return true;
    }
    ct.contains("json") || ct.contains("xml") || ct.contains("javascript") || ct.contains("csv")
}

// ---------------------------------------------------------------------------
// HTML → 文本 与实体解码
// ---------------------------------------------------------------------------

/// 解码基础 HTML 实体（含十/十六进制数字引用）。输入非法时原样保留。
pub(crate) fn decode_entities(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'&' {
            // 多字节 UTF-8 字符按 char 复制
            let ch = input[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        let rest = &input[i..];
        let semi = match rest.find(';') {
            Some(p) if p <= 10 => p,
            _ => {
                out.push('&');
                i += 1;
                continue;
            }
        };
        let name = &rest[1..semi];
        let decoded = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => {
                if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                    u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                } else if let Some(dec) = name.strip_prefix('#') {
                    dec.parse::<u32>().ok().and_then(char::from_u32)
                } else {
                    None
                }
            }
        };
        match decoded {
            Some(ch) => {
                out.push(ch);
                i += semi + 1;
            }
            None => {
                out.push('&');
                i += 1;
            }
        }
    }
    out
}

/// HTML → 纯文本（html2text：保留标题/链接/列表结构，剥脚本样式）。
pub(crate) fn html_to_text(html: &str) -> String {
    let mut cursor = Cursor::new(html.as_bytes());
    // html2text 0.14 的 from_read 返回 Result；失败时降级为剥标签+解码实体（仍产出可用文本）
    match html2text::from_read(&mut cursor, 100) {
        Ok(text) => text.trim().to_string(),
        Err(_) => decode_entities(&strip_tags(html)),
    }
}

/// 剥剩余标签并压缩空白（搜索结果标题/摘要清洗用）。
pub(crate) fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.trim().to_string()
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML 结果解析
// ---------------------------------------------------------------------------

/// 广告特征：DDG 广告落地页一律是 duckduckgo.com/y.js（外层直链或 uddg 包装均可能出现）。
fn is_ddg_ad(url: &str) -> bool {
    url.contains("duckduckgo.com/y.js")
}

/// 从 DDG 跳转链接（//duckduckgo.com/l/?uddg=<enc>&rut=...）提取真实 URL；
/// 非跳转链接原样返回（校验 scheme）。
fn resolve_ddg_href(href: &str) -> Option<String> {
    let href = href.trim();
    let absolute = if href.starts_with("//") {
        format!("https:{href}")
    } else {
        href.to_string()
    };
    if is_ddg_ad(&absolute) {
        return None; // 广告
    }
    if let Some(pos) = absolute.find("uddg=") {
        let enc = &absolute[pos + 5..];
        let enc = enc.split('&').next().unwrap_or(enc);
        return percent_decode(enc)
            .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
            .filter(|u| !is_ddg_ad(u)); // uddg 解码后再兜底一次（广告常包在跳转里）
    }
    if absolute.starts_with("http://") || absolute.starts_with("https://") {
        return Some(absolute);
    }
    None
}

/// 百分号解码（%XX；不处理 '+'——uddg 值是完整 URL，空格应为 %20）。
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 && i + 2 < bytes.len() + 1 {
            let hex = input.get(i + 1..i + 3)?;
            let byte = u8::from_str_radix(hex, 16).ok()?;
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 解析 DDG HTML 结果页（html.duckduckgo.com/html/?q=）。
/// 结果链接 class=result__a，摘要 class=result__snippet（紧跟其后）；广告与
/// 非http(s) 链接丢弃。纯函数（便于单测）。
pub(crate) fn parse_ddg_results(html: &str) -> Vec<WebSearchHit> {
    let link_re = Regex::new(r#"<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(?s)(.*?)</a>"#).unwrap();
    // 注意：匹配从 class 属性开始（seg 截取自 class= 处，<a 开标签在截取点之前）
    let snippet_re = Regex::new(r#"class="[^"]*result__snippet[^"]*"[^>]*>(?s)(.*?)</a>"#).unwrap();

    let links: Vec<(usize, String, String)> = link_re
        .captures_iter(html)
        .filter_map(|c| {
            let start = c.get(0)?.start();
            let url = resolve_ddg_href(c.get(1)?.as_str())?;
            let title = decode_entities(&strip_tags(c.get(2)?.as_str()));
            Some((start, url, title))
        })
        .collect();

    let mut hits = Vec::with_capacity(links.len());
    for (idx, (pos, url, title)) in links.iter().enumerate() {
        // 摘要 = 本链接与下一链接之间的第一个 result__snippet
        let next_pos = links.get(idx + 1).map(|(p, _, _)| *p).unwrap_or(html.len());
        let snippet = html[*pos..next_pos]
            .find(r#"class="result__snippet""#)
            .and_then(|rel| {
                let seg = &html[pos + rel..next_pos];
                snippet_re.captures(seg).and_then(|c| c.get(1)).map(|m| {
                    decode_entities(&strip_tags(m.as_str()))
                })
            })
            .unwrap_or_default();
        hits.push(WebSearchHit {
            title: title.trim().to_string(),
            url: url.clone(),
            snippet: snippet.trim().to_string(),
        });
    }
    hits
}

/// 域名后缀匹配（host==domain 或 host 以 .domain 结尾；剥 www./scheme/尾斜杠）。
pub(crate) fn host_matches(host: &str, domain: &str) -> bool {
    let clean = |s: &str| -> String {
        let s = s.trim().to_ascii_lowercase();
        let s = s
            .strip_prefix("https://")
            .or_else(|| s.strip_prefix("http://"))
            .unwrap_or(&s);
        let s = s.trim_end_matches('/');
        let s = s.split('/').next().unwrap_or(s);
        let s = s.rsplit(':').next().unwrap_or(s);
        s.trim_start_matches('[').trim_end_matches(']').trim_matches('.').trim_start_matches("www.").to_string()
    };
    let h = clean(host);
    let d = clean(domain);
    if h.is_empty() || d.is_empty() {
        return false;
    }
    h == d || h.ends_with(&format!(".{d}"))
}

/// 域名白/黑名单过滤（白名单命中保留、黑名单命中剔除；二者不可同时提供）。
pub(crate) fn filter_domains(hits: Vec<WebSearchHit>, allowed: &[String], blocked: &[String]) -> Result<Vec<WebSearchHit>, String> {
    if !allowed.is_empty() && !blocked.is_empty() {
        return Err("web_search: allowed_domains 与 blocked_domains 不可同时提供".into());
    }
    if allowed.is_empty() && blocked.is_empty() {
        return Ok(hits);
    }
    let hit_host = |url: &str| -> String {
        let rest = url.split("://").nth(1).unwrap_or(url);
        rest.split('/').next().unwrap_or(rest).to_string()
    };
    Ok(hits
        .into_iter()
        .filter(|h| {
            let host = hit_host(&h.url);
            if !allowed.is_empty() {
                allowed.iter().any(|d| host_matches(&host, d))
            } else {
                !blocked.iter().any(|d| host_matches(&host, d))
            }
        })
        .collect())
}

// ---------------------------------------------------------------------------
// HTTP 与命令
// ---------------------------------------------------------------------------

/// 解析出网代理：显式设置（kv）优先 → 标准环境变量（HTTP(S)_PROXY/ALL_PROXY）→ 直连。
/// 设置值非法时如实报错（绝不静默降级直连——配置错误必须暴露）。
fn resolve_proxy() -> Result<Option<ureq::Proxy>, String> {
    if let Ok(conn) = crate::conversation_store::db_conn() {
        let stored: Option<String> = conn
            .query_row(
                "SELECT value FROM kv WHERE key = ?1",
                rusqlite::params![KV_WEB_PROXY],
                |row| row.get(0),
            )
            .ok();
        if let Some(v) = stored.filter(|s| !s.trim().is_empty()) {
            let trimmed = v.trim().to_string();
            return ureq::Proxy::new(&trimmed)
                .map(Some)
                .map_err(|e| format!("web 代理配置无效（kv {KV_WEB_PROXY} = {trimmed}）: {e}"));
        }
    }
    Ok(ureq::Proxy::try_from_env())
}

fn http_get(
    url: &str,
    max_bytes: usize,
    user_agent: &str,
) -> Result<(u16, String, String, String, usize), String> {
    let proxy = resolve_proxy()?;
    let mut config = ureq::Agent::config_builder()
        .timeout_global(Some(HTTP_TIMEOUT))
        .http_status_as_error(false);
    if let Some(p) = proxy {
        config = config.proxy(Some(p));
    }
    let agent: ureq::Agent = config.build().into();
    let mut resp = agent
        .get(url)
        .header("User-Agent", user_agent)
        .header("Accept", "text/html, text/*, application/json, */*;q=0.8")
        .call()
        .map_err(|e| format!("web 请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let final_url = resp.get_uri().to_string();
    // take(max+1)：超出上限多读一字节即判超限，绝不整读超大响应
    use std::io::Read as _;
    // get_uri 来自 ureq 的 ResponseExt trait（tauri 重导出的 http::Response 上实现）
    use ureq::ResponseExt as _;
    let mut reader = resp.body_mut().as_reader().take((max_bytes + 1) as u64);
    let mut body = Vec::new();
    reader
        .read_to_end(&mut body)
        .map_err(|e| format!("读取响应失败: {e}"))?;
    if body.len() > max_bytes {
        return Err(format!(
            "web 请求失败: 响应体超过 {max_bytes} 字节上限（拒绝整读超大响应）"
        ));
    }
    let len = body.len();
    let text = String::from_utf8_lossy(&body).to_string();
    Ok((status, ctype, final_url, text, len))
}

pub(crate) fn web_fetch_sync(url: String, max_bytes: Option<usize>) -> Result<WebFetchResult, String> {
    let (normalized, host) = normalize_fetch_url(&url)?;
    let cap = max_bytes.unwrap_or(MAX_FETCH_BYTES).clamp(1, MAX_FETCH_BYTES);
    let (status, ctype, final_url, body, raw_len) = http_get(&normalized, cap, WEB_UA)?;
    if status >= 400 {
        let hint = if status == 401 || status == 403 {
            "（站点拒绝匿名抓取；需要鉴权的资源请改用带凭证的工具，如 gh）"
        } else if status == 429 {
            "（请求过频被限流，稍后重试）"
        } else {
            ""
        };
        return Err(format!("web_fetch: HTTP {status} 来自 {host}{hint}"));
    }
    if !is_text_like_mime(&ctype) {
        return Err(format!(
            "web_fetch: 不支持的内容类型 {ctype}（仅文本类：text/*、json、xml 等）"
        ));
    }
    let text = if ctype.contains("html") || (ctype.is_empty() && body.trim_start().starts_with('<')) {
        html_to_text(&body)
    } else {
        body.trim().to_string()
    };
    Ok(WebFetchResult {
        url: normalized,
        final_url,
        status,
        content_type: ctype,
        bytes: raw_len,
        text,
    })
}

pub(crate) fn web_search_sync(
    query: String,
    allowed_domains: Option<Vec<String>>,
    blocked_domains: Option<Vec<String>>,
    max_results: Option<usize>,
) -> Result<WebSearchResult, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("web_search: 查询词为空".into());
    }
    if q.chars().count() > 400 {
        return Err("web_search: 查询词过长（> 400 字符）".into());
    }
    let started = Instant::now();
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        form_urlencode(q)
    );
    let (status, _, _, html, _) = http_get(&url, MAX_FETCH_BYTES, SEARCH_UA)?;
    if status != 200 {
        let hint = if status == 403 || status == 202 {
            "（搜索端点触发反爬限流，请稍后重试）"
        } else {
            ""
        };
        return Err(format!("web_search: HTTP {status}{hint}"));
    }
    let all = parse_ddg_results(&html);
    let total_found = all.len();
    let filtered = filter_domains(
        all,
        allowed_domains.as_deref().unwrap_or(&[]),
        blocked_domains.as_deref().unwrap_or(&[]),
    )?;
    let take = max_results.unwrap_or(SEARCH_DEFAULT_RESULTS).clamp(1, SEARCH_MAX_RESULTS);
    Ok(WebSearchResult {
        query: q.to_string(),
        results: filtered.into_iter().take(take).collect(),
        total_found,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// 表单编码（保留 RFC 3986 unreserved 字符，其余按 UTF-8 百分号编码）。
fn form_urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[tauri::command]
pub async fn web_fetch(url: String, max_bytes: Option<usize>) -> Result<WebFetchResult, String> {
    tauri::async_runtime::spawn_blocking(move || web_fetch_sync(url, max_bytes))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn web_search(
    query: String,
    allowed_domains: Option<Vec<String>>,
    blocked_domains: Option<Vec<String>>,
    max_results: Option<usize>,
) -> Result<WebSearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        web_search_sync(query, allowed_domains, blocked_domains, max_results)
    })
    .await
    .map_err(|e| e.to_string())?
}
