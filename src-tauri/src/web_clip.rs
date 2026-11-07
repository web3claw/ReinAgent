//! 网页文章抓取与收藏落盘（2026-11-02，ReinBot 链接收藏管道）。
//!
//! - `article_fetch`：HTTP 直抓（浏览器 UA）+ dom_query 启发式正文提取，
//!   输出结构化纯文本（标题/段落/列表），供大模型总结；
//!   正文过短（<200 字）时如实报错（疑似 JS 渲染页），绝不编造内容。
//! - `clip_save`：把总结落盘为「收藏夹」笔记本下的笔记（独立目录 =
//!   笔记本目录），返回知识索引所需的 source_id（`{notebook}:{file}`）；
//!   也可指定其他笔记本作为归档目标。
//! - `wechat_typing_notify`：微信「对方正在输入」指示（getconfig 取
//!   typing_ticket → sendtyping status=1），不占用被动回复额度。
//!
//! 所有失败如实上抛（No-Fallback）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const FETCH_TIMEOUT_SECS: u64 = 20;
const MAX_TEXT_CHARS: usize = 24_000;
const MIN_TEXT_CHARS: usize = 200;
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/// 微信 iLink 通道版本（与 wechat_gateway 一致）。
const WX_CHANNEL_VERSION: &str = "1.0.2";

// ---------------- 文章抓取 ----------------

#[derive(Deserialize)]
pub struct ArticleFetchArgs {
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleFetched {
    pub title: String,
    pub site: String,
    pub text: String,
    pub char_count: usize,
    pub truncated: bool,
}

/// 抓取并提取文章正文（两层：HTTP 直抓 → 正文过短时启用内置浏览器渲染抓取）。
pub async fn article_fetch(
    app: tauri::AppHandle,
    args: ArticleFetchArgs,
) -> Result<ArticleFetched, String> {
    let url = args.url.trim().to_string();
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err(format!("仅支持 http(s) 链接（收到：{url}）"));
    }
    let client = crate::app_proxy::build_proxied_reqwest_client(
        &url,
        Some(Duration::from_secs(10)),
        Some(Duration::from_secs(FETCH_TIMEOUT_SECS)),
    )?;
    let resp = client
        .get(&url)
        .header("User-Agent", BROWSER_UA)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|e| format!("抓取网页失败：{e}"))?;
    let status = resp.status();
    let final_url = resp.url().clone();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let html = resp.text().await.map_err(|e| format!("读取网页内容失败：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "HTTP {status}（站点拒绝或链接无效）"
        ));
    }
    if !content_type.contains("html") && !html.trim_start().starts_with('<') {
        return Err(format!(
            "该链接不是网页文章（content-type: {content_type}），暂不支持"
        ));
    }

    let (mut title, mut text) = extract_article(&html);
    let http_text_len = text.trim().chars().count();

    // 第二层：HTTP 直抓正文过短（SPA/JS 渲染页，如掘金/知乎）→ 内置浏览器渲染后提取
    if http_text_len < MIN_TEXT_CHARS {
        match render_article_via_browser(&app, &url).await {
            Ok((r_title, r_text)) => {
                if !r_title.trim().is_empty() {
                    title = r_title;
                }
                text = r_text;
            }
            Err(render_err) => {
                return Err(format!(
                    "HTTP 直抓仅得 {http_text_len} 字（疑似 JS 渲染页），内置浏览器渲染也没能取到正文：{render_err}"
                ));
            }
        }
    }

    if title.trim().is_empty() && text.trim().is_empty() {
        return Err("页面无可提取的正文（可能是 JS 渲染页或非文章页面）".to_string());
    }
    let text = text.trim().to_string();
    if text.chars().count() < MIN_TEXT_CHARS {
        return Err(format!(
            "提取到的正文过短（{} 字，HTTP 直抓与浏览器渲染均未取到正文），暂不支持该站点",
            text.chars().count()
        ));
    }
    let site = final_url
        .host_str()
        .unwrap_or("")
        .to_string();
    let char_count = text.chars().count();
    let truncated = char_count > MAX_TEXT_CHARS;
    let text = if truncated {
        text.chars().take(MAX_TEXT_CHARS).collect::<String>() + "\n…（原文过长，已截断）"
    } else {
        text
    };
    Ok(ArticleFetched {
        title: if title.trim().is_empty() {
            site.clone()
        } else {
            title.trim().to_string()
        },
        site,
        text,
        char_count: char_count.min(MAX_TEXT_CHARS),
        truncated,
    })
}

/// 第二层抓取：用内置浏览器加载页面（真实执行 JS）→ 注入提取脚本取正文。
/// 浏览器若原本未打开，会临时打开并在结束后关闭（不打扰已有会话）。
async fn render_article_via_browser(
    app: &tauri::AppHandle,
    url: &str,
) -> Result<(String, String), String> {
    // 总硬超时：即便页面卡死也必须在 35s 内返回（否则会挂住整个工具调用/回合）
    match tokio::time::timeout(
        Duration::from_secs(35),
        render_article_via_browser_inner(app, url),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => {
            // 超时兜底：关闭可能卡住的浏览器面板，避免后续调用继续排队
            let _ = crate::browser::browser_close(app.clone()).await;
            Err("内置浏览器渲染超时（35s，页面无响应）".to_string())
        }
    }
}

async fn render_article_via_browser_inner(
    app: &tauri::AppHandle,
    url: &str,
) -> Result<(String, String), String> {
    use tauri::Manager as _;
    let was_open = app
        .get_window("main")
        .map(|w| w.get_webview(crate::browser::BROWSER_LABEL).is_some())
        .unwrap_or(false);

    // 打开（或导航已有）内置浏览器到目标页
    crate::browser::browser_open(app.clone(), url.to_string()).await?;
    // ⚠️ 关键防串页（2026-11-02 实测 bug）：浏览器已打开时 browser_open 走 navigate，
    // 页面切换有延迟；若立刻读取会拿到**上一篇残留内容**（收藏内容与来源链接不符）。
    // 必须先确认 current_url 已切到目标页，再开始提取。
    let target_frag = url.split("://").nth(1).unwrap_or(url);
    let mut nav_ok = false;
    for _ in 0..15 {
        tokio::time::sleep(Duration::from_millis(800)).await;
        match crate::browser::browser_current_url(app.clone()).await {
            Ok(cur) => {
                let cur_frag = cur.split("://").nth(1).unwrap_or(&cur);
                // 目标 URL 的关键片段落在当前地址里（忽略末尾斜杠/查询串差异）
                let key = target_frag.split('?').next().unwrap_or(target_frag).trim_end_matches('/');
                if cur.contains(key) || key.contains(cur_frag.trim_end_matches('/')) {
                    nav_ok = true;
                    break;
                }
            }
            Err(_) => {}
        }
    }
    if !nav_ok {
        // 地址未切过去 → 绝不读取（否则就是上一篇的内容），如实报错
        if !was_open {
            let _ = crate::browser::browser_close(app.clone()).await;
        }
        return Err(format!("内置浏览器导航未完成（当前页面不是 {url}），已中止以避免抓到错误内容"));
    }
    // 地址已切换：再给首帧与 JS 渲染留时间
    tokio::time::sleep(Duration::from_secs(2)).await;
    // 等页面 JS 渲染与正文出现（轮询窗口最多 ~20s）
    let extract_js = r#"
      (function(){
        var sel = ['article','main','[role=main]','.article-content','.post-content','.content','#content','.markdown-body'];
        var best = null, bestLen = 0;
        for (var i = 0; i < sel.length; i++) {
          var el = document.querySelector(sel[i]);
          if (!el) continue;
          var t = el.innerText || '';
          if (t.length > bestLen) { best = el; bestLen = t.length; }
        }
        if (!best || bestLen < 200) {
          var body = document.body;
          best = body; bestLen = (body.innerText || '').length;
        }
        return JSON.stringify({
          title: (document.querySelector('meta[property="og:title"]') || {}).content
              || document.title || '',
          text: (best.innerText || '').slice(0, 40000),
        });
      })()
    "#;
    let mut last_err = String::from("未取到正文");
    for attempt in 0..12 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        // 前两次 read 超时很可能只是 webview 未就绪，继续轮询而非立即放弃
        let _ = attempt;
        let read_res = tokio::time::timeout(
            Duration::from_secs(18),
            crate::browser::browser_read_page(app.clone(), extract_js.to_string()),
        )
        .await
        .unwrap_or_else(|_| Err("browser read 外层超时（18s）".to_string()));
        match read_res {
            Ok(raw) => {
                let v: Value = match serde_json::from_str(&raw) {
                    Ok(v) => v,
                    Err(e) => {
                        last_err = format!("渲染结果解析失败：{e}（前 200 字：{}）", truncate_str(&raw, 200));
                        continue;
                    }
                };
                let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                if text.chars().count() >= MIN_TEXT_CHARS {
                    let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if !was_open {
                        let _ = crate::browser::browser_close(app.clone()).await;
                    }
                    return Ok((title, text));
                }
                last_err = format!("渲染后正文仍过短（{} 字）", text.chars().count());
            }
            Err(e) => {
                last_err = e;
            }
        }
    }
    if !was_open {
        let _ = crate::browser::browser_close(app.clone()).await;
    }
    Err(last_err)
}

/// 启发式正文提取：剥除噪声节点 → 候选容器 → 结构化文本。
fn extract_article(html: &str) -> (String, String) {
    let doc = dom_query::Document::from(html);
    // 噪声节点整体移除
    doc.select("script,style,noscript,svg,iframe,form,nav,header,footer,aside,template,button,input,select,textarea")
        .remove();

    // 标题优先级（2026-11-02 修正）：第一个 h1（页面主标题最准）→ og:title → <title>
    // 掘金等站点无 og:title 且 <title> 塞了「标题+正文摘要+站名」，h1 才是干净标题。
    let h1_title = doc.select("h1").text().to_string().trim().to_string();
    let og_title = doc
        .select(r#"meta[property="og:title"]"#)
        .attr("content")
        .map(|s| s.to_string())
        .unwrap_or_default();
    let doc_title = doc.select("title").text().to_string().trim().to_string();
    let raw_title = if !h1_title.is_empty() {
        h1_title
    } else if !og_title.trim().is_empty() {
        og_title
    } else {
        doc_title
    };
    // 站点常把「标题 + 正文摘要 + 站名」塞进 <title>（掘金/公众号尤甚）：
    // 按常见分隔符切出主标题并限长 100，避免文件名被正文淹没。
    let title = normalize_article_title(&raw_title);

    // 正文容器候选（按优先级取第一个非空）
    let text = ["article", "main", r#"[role="main"]"#, ".article-content", ".post-content", ".content", "#content", "#app"]
        .iter()
        .find_map(|sel| {
            let sel = doc.select(sel);
            if sel.length() == 0 {
                return None;
            }
            let html = sel.inner_html().to_string();
            let t = html_to_text(&html);
            (t.chars().count() >= MIN_TEXT_CHARS).then_some(t)
        })
        .unwrap_or_else(|| {
            // 兜底：整个 body
            let body = doc.select("body");
            if body.length() > 0 {
                html_to_text(&body.inner_html().to_string())
            } else {
                html_to_text(html)
            }
        });

    (title, text)
}

/// 规约文章标题：站点常把「标题 正文摘要 - 站名」塞进 `<title>`。
/// 按常见分隔符切出主标题，去空白、限长 100 字符（留足文件名余量）。
pub fn normalize_article_title(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // 分隔符优先级：竖线 → 破折号（- – —）→ 下划线串；只取第一段
    let mut cut = trimmed.to_string();
    for sep in [" | ", "｜", " - ", " – ", " — ", " _ ", " — "] {
        if let Some(idx) = cut.find(sep) {
            // 只在该段足够长（>=4 字）时才切，避免把 "A - B" 这类真标题切碎
            if idx >= 4 {
                cut = cut[..idx].to_string();
                break;
            }
        }
    }
    let mut cleaned = cut.split_whitespace().collect::<Vec<_>>().join(" ");
    cleaned = cleaned
        .trim_matches(|c: char| c == '-' || c == '|' || c == '_' || c.is_whitespace())
        .to_string();
    if cleaned.is_empty() {
        return trimmed.chars().take(100).collect();
    }
    // 仍过长（>60 字）→ 说明摘要混进来了：截到第一个句末标点（？。！?!）之后
    if cleaned.chars().count() > 60 {
        if let Some(pos) = cleaned.find(|c: char| c == '？' || c == '?' || c == '。' || c == '！' || c == '!') {
            let (head, _) = cleaned.split_at(pos + cleaned[pos..].chars().next().map(|c| c.len_utf8()).unwrap_or(1));
            if head.chars().count() >= 4 {
                cleaned = head.trim().to_string();
            }
        }
    }
    cleaned.chars().take(100).collect()
}

/// 简易 HTML → 结构化文本：块级标签转行，标题加 ## 前缀，实体解码，折叠空行。
fn html_to_text(html: &str) -> String {
    let mut s = html.to_string();
    // 块级边界 → 换行（先打占位，避免标签内属性干扰）
    for tag in [
        "</p>", "</div>", "</section>", "</article>", "</li>", "</tr>", "</blockquote>",
        "</h1>", "</h2>", "</h3>", "</h4>", "</h5>", "</h6>", "</pre>", "</table>", "<br>", "<br/>", "<br />",
    ] {
        s = s.replace(tag, "\n");
    }
    for h in ["h2", "h3", "h4", "h5", "h6"] {
        s = s.replace(&format!("<{h}"), &format!("\n## <{h}"));
    }
    s = s.replace("<h1", "\n# <h1");
    s = s.replace("<li", "\n- <li");
    // 剥除全部标签
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    // 实体解码（高频项）
    let out = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&hellip;", "…")
        .replace("&mdash;", "—")
        .replace("&ldquo;", "“")
        .replace("&rdquo;", "”")
        .replace("&lsquo;", "‘")
        .replace("&rsquo;", "’");
    // 折叠空白行（3+ → 1 空行）+ 行首尾空白
    let mut lines: Vec<String> = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() {
            if lines.last().map(|l: &String| !l.is_empty()).unwrap_or(false) {
                lines.push(String::new());
            }
        } else {
            lines.push(t.to_string());
        }
    }
    lines.join("\n")
}

// ---------------- 收藏落盘 ----------------

#[derive(Deserialize)]
pub struct ClipSaveArgs {
    pub title: String,
    /// 总结正文（markdown）。
    pub summary: String,
    pub source_url: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub site: String,
    /// 归档笔记本（默认「收藏夹」）。
    #[serde(default)]
    pub notebook: Option<String>,
    /// 来源渠道（qq | wechat | feishu | desktop），写入 frontmatter。
    #[serde(default)]
    pub channel: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSaved {
    pub path: String,
    /// 知识索引 source_id（`{notebook}:{file}`）。
    pub source_id: String,
    pub notebook: String,
}

/// 今日日期（本地时区，YYYY-MM-DD）。
fn today_string() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 简化：用天数换算 UTC 日期（时区偏差可接受，归档文件名场景）
    let days = now / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

fn truncate_str(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let cut: String = s.chars().take(n).collect();
        format!("{cut}…")
    }
}

/// 天数 → (年, 月, 日)（Howard Hinnant 算法，UTC）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 文件名 slug：保留中日文/字母/数字，禁字符转 `-`，限长 60。
pub fn clip_slug(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join("-");
    let mut collapsed = collapsed;
    while collapsed.contains("--") {
        collapsed = collapsed.replace("--", "-");
    }
    let trimmed = collapsed.trim_matches('-').to_string();
    let mut slug: String = trimmed.chars().take(60).collect();
    while slug.ends_with('-') || slug.ends_with('.') {
        slug.pop();
    }
    if slug.trim().is_empty() {
        "untitled".to_string()
    } else {
        slug
    }
}

/// 收藏落盘：写入笔记本（默认「收藏夹」，不存在则创建），返回知识索引 source_id。
pub async fn clip_save(args: ClipSaveArgs) -> Result<ClipSaved, String> {
    let title = args.title.trim().to_string();
    if title.is_empty() {
        return Err("收藏标题不能为空".to_string());
    }
    if args.summary.trim().is_empty() {
        return Err("收藏内容为空".to_string());
    }
    if args.source_url.trim().is_empty() {
        return Err("来源 URL 为空".to_string());
    }
    let notebook = args
        .notebook
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("收藏夹")
        .to_string();

    // 确保笔记本存在（顶级；已存在则跳过创建）
    let folders = crate::notes_fs::notes_list_notebooks().await?;
    let exists = folders
        .iter()
        .any(|f| f.name == notebook || f.relative_path == notebook);
    if !exists {
        crate::notes_fs::notes_create_notebook(None, notebook.clone()).await?;
    }

    let file_name = format!("{}-{}.md", today_string(), clip_slug(&title));
    let channel = args.channel.as_deref().unwrap_or("unknown");
    // 正文不带 frontmatter（2026-11-02 用户拍板：YAML 头在笔记视图里是一坨原文）：
    // 来源/渠道/时间以文末「收藏信息」行承载，标签改存笔记系统 note_tags（顶部标签栏可见）。
    let source_line = if args.site.trim().is_empty() {
        args.source_url.trim().to_string()
    } else {
        format!("{}（{}）", args.source_url.trim(), args.site.trim())
    };
    // 正文不再重复写 `# 标题`（2026-11-02 用户反馈）：笔记视图顶部已显示文件名，
    // 正文里再放一级标题就是重复。正文直接从总结内容开始。
    let content = format!(
        "{}\n\n---\n来源：{source_line} · 渠道：{channel} · 收藏于 {}\n",
        args.summary.trim(),
        chrono_like_now(),
    );

    crate::notes_fs::notes_save_note(notebook.clone(), file_name.clone(), content, Some("clip".to_string())).await?;

    // 标签写入笔记系统（note_tags 多对多；失败不阻断保存——标签是旁路增强）
    let tags: Vec<String> = args
        .tags
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if !tags.is_empty() {
        if let Err(err) = crate::notes_meta::notes_set_tags(
            notebook.clone(),
            file_name.clone(),
            tags.clone(),
        )
        .await
        {
            eprintln!("[clip] 标签写入失败（已忽略，收藏本身成功）：{err}");
        }
    }

    let root = crate::notes_fs::get_notebooks_root();
    let path = root.join(&notebook).join(&file_name);
    let source_id = format!("{notebook}:{file_name}");
    Ok(ClipSaved {
        path: path.to_string_lossy().to_string(),
        source_id,
        notebook,
    })
}

/// 当前 UTC 时间 ISO 字符串（frontmatter 用，秒级足够）。
fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d) = civil_from_days((now / 86_400) as i64);
    let secs_today = now % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs_today / 3600,
        (secs_today % 3600) / 60,
        secs_today % 60
    )
}

// ---------------- 微信「正在输入」通知（不占回复额度） ----------------

#[derive(Deserialize)]
pub struct WechatTypingArgs {
    pub bot_token: String,
    #[serde(default)]
    pub base_url: Option<String>,
    /// 扫码人的 iLink 用户 ID（getconfig 必需）。
    pub ilink_user_id: String,
}

/// getconfig → typing_ticket → sendtyping（status=1 正在输入）。
pub async fn wechat_typing_notify(args: &WechatTypingArgs) -> Result<(), String> {
    let base = args
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| crate::im_channels::WECHAT_DEFAULT_BASE_URL.to_string());
    let client = crate::app_proxy::build_proxied_reqwest_client(
        &base,
        Some(Duration::from_secs(10)),
        Some(Duration::from_secs(15)),
    )?;

    // ① getconfig → typing_ticket
    let cfg_url = format!("{base}/ilink/bot/getconfig");
    let cfg_resp = client
        .post(&cfg_url)
        .header("AuthorizationType", "ilink_bot_token")
        .header("Authorization", format!("Bearer {}", args.bot_token.trim()))
        .header("Content-Type", "application/json")
        .body(
            serde_json::json!({
                "ilink_user_id": args.ilink_user_id.trim(),
                "base_info": { "channel_version": WX_CHANNEL_VERSION },
            })
            .to_string(),
        )
        .send()
        .await
        .map_err(|e| format!("getconfig 失败：{e}"))?;
    let cfg_status = cfg_resp.status();
    let cfg_text = cfg_resp.text().await.unwrap_or_default();
    if !cfg_status.is_success() {
        return Err(format!("getconfig HTTP {cfg_status}"));
    }
    let cfg: Value = serde_json::from_str(&cfg_text)
        .map_err(|e| format!("getconfig 解析失败：{e}（原文前 200 字：{}）", truncate_str(&cfg_text, 200)))?;
    let ret = cfg.get("ret").and_then(|x| x.as_i64()).unwrap_or(0);
    if ret != 0 {
        let msg = cfg.get("errmsg").and_then(|x| x.as_str()).unwrap_or("");
        return Err(format!("iLink 返回 ret={ret} {msg}"));
    }
    let ticket = cfg
        .get("typing_ticket")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "getconfig 未返回 typing_ticket".to_string())?
        .to_string();

    // ② sendtyping（status=1 正在输入）
    let typing_url = format!("{base}/ilink/bot/sendtyping");
    let resp = client
        .post(&typing_url)
        .header("AuthorizationType", "ilink_bot_token")
        .header("Authorization", format!("Bearer {}", args.bot_token.trim()))
        .header("Content-Type", "application/json")
        .body(
            serde_json::json!({
                "ilink_user_id": args.ilink_user_id.trim(),
                "typing_ticket": ticket,
                "status": 1,
                "base_info": { "channel_version": WX_CHANNEL_VERSION },
            })
            .to_string(),
        )
        .send()
        .await
        .map_err(|e| format!("sendtyping 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("sendtyping HTTP {status}"));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("sendtyping 解析失败：{e}（原文前 200 字：{}）", truncate_str(&text, 200)))?;
    let ret = v.get("ret").and_then(|x| x.as_i64()).unwrap_or(0);
    if ret != 0 {
        let msg = v.get("errmsg").and_then(|x| x.as_str()).unwrap_or("");
        return Err(format!("iLink 返回 ret={ret} {msg}"));
    }
    Ok(())
}

// ---------------- Tauri 命令 ----------------

#[tauri::command]
pub async fn im_article_fetch(
    app: tauri::AppHandle,
    args: ArticleFetchArgs,
) -> Result<ArticleFetched, String> {
    article_fetch(app, args).await
}

#[tauri::command]
pub async fn im_clip_save(args: ClipSaveArgs) -> Result<ClipSaved, String> {
    clip_save(args).await
}

#[tauri::command]
pub async fn im_wechat_typing_notify(args: WechatTypingArgs) -> Result<(), String> {
    wechat_typing_notify(&args).await
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 正文提取：script/nav 剥除 + article 容器优先 + 标题取 og:title。
    #[test]
    fn article_extraction() {
        let html = r#"<html><head><meta property="og:title" content="测试文章标题"><title>fallback</title></head>
        <body><nav>菜单 导航 链接 一堆</nav><script>var evil = "script text must go";</script>
        <article><h2>第一节</h2><p>这是正文第一段，讲的是某个技术的核心原理。</p><p>第二段展开细节，包含更多论证与例子。</p>
        <ul><li>要点一</li><li>要点二</li></ul></article><footer>版权所有 页脚</footer></body></html>"#;
        let (title, text) = extract_article(html);
        assert_eq!(title, "测试文章标题");
        assert!(text.contains("## 第一节"), "标题应转 ##：{text}");
        assert!(text.contains("这是正文第一段"));
        assert!(text.contains("- 要点一"), "列表应转 -：{text}");
        assert!(!text.contains("evil"), "script 内容必须剥除");
        assert!(!text.contains("菜单"), "nav 内容必须剥除");
        assert!(!text.contains("版权所有"), "footer 内容必须剥除");
    }

    /// 正文过短 → extract 返回短文本（article_fetch 层报错，此处验证提取器行为）。
    #[test]
    fn short_body_extraction() {
        let (_, text) = extract_article("<html><body><p>短</p></body></html>");
        assert!(text.chars().count() < 200);
    }

    /// 标题规约：站点拼接的「标题 + 摘要 - 站名」应切出主标题并限长。
    #[test]
    fn normalize_title() {
        // 掘金典型：标题 + 正文摘要 + 站名
        let juejin = "为什么越来越多人用 ZXing？前言 不知道你有没有做过支付系统 - 掘金";
        let t = normalize_article_title(juejin);
        assert!(t.starts_with("为什么越来越多人用 ZXing？"), "{t}");
        assert!(!t.ends_with("掘金"), "站名应被切掉：{t}");
        assert!(t.chars().count() <= 100);
        // 竖线分隔
        assert_eq!(normalize_article_title("Rust 异步编程 | 知乎"), "Rust 异步编程");
        // 无分隔符：原样（限长）
        assert_eq!(normalize_article_title("  短标题  "), "短标题");
        // 空
        assert_eq!(normalize_article_title("   "), "");
        // 超长无分隔符 → 截断 100
        let long = normalize_article_title(&"长".repeat(200));
        assert_eq!(long.chars().count(), 100);
    }

    /// slug：禁字符转 -、空白折叠、长度截断、空标题兜底。
    #[test]
    fn slug_generation() {
        assert_eq!(clip_slug("Hello World"), "Hello-World");
        assert_eq!(clip_slug("Rust: 2026 指南"), "Rust-2026-指南");
        assert_eq!(clip_slug("a/b\\c:d*e?f\"g<h>i|j"), "a-b-c-d-e-f-g-h-i-j");
        assert_eq!(clip_slug(""), "untitled");
        assert_eq!(clip_slug("///"), "untitled");
        let long = clip_slug(&"长".repeat(100));
        assert_eq!(long.chars().count(), 60);
    }

    /// 日期工具：civil_from_days 基准（2026-11-01 = 20693 天）。
    #[test]
    fn civil_date_known_value() {
        assert_eq!(civil_from_days(20_758), (2026, 11, 1));
    }

    /// clip_save 全链路：笔记本自动创建 + frontmatter 落盘 + source_id 形态。
    /// （写真实 notebooks 根目录 —— 与 notes 测试同款风险，用独立笔记本名 + 收尾清理）
    #[tokio::test]
    async fn clip_save_writes_note() {
        let notebook = format!("收藏夹-test-{}", std::process::id());
        let saved = clip_save(ClipSaveArgs {
            title: "测试收藏文章".to_string(),
            summary: "这是一段总结。".to_string(),
            source_url: "https://example.com/post/1".to_string(),
            tags: vec!["测试".to_string(), "rust".to_string()],
            site: "example.com".to_string(),
            notebook: Some(notebook.clone()),
            channel: Some("desktop".to_string()),
        })
        .await
        .expect("clip_save 应成功");
        assert!(saved.source_id.starts_with(&format!("{notebook}:")));
        assert!(saved.source_id.ends_with(".md"));
        assert!(saved.path.contains(&notebook));

        // 清理（测试写的是真实 notebooks 根目录）
        let root = crate::notes_fs::get_notebooks_root();
        let _ = std::fs::remove_dir_all(root.join(&notebook));
    }
}
