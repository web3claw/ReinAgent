//! 会话搜索（对齐 LiveAgent `chat_history_search` 的一期子集）：
//! 在 conversations.db 的 message / part / task 表上做全词 LIKE 匹配
//! （FTS5 虚表二期再引入），返回按任务分组的命中（标题命中加权、带片段高亮标记）。
//! 高亮标记沿用 LiveAgent 的 `[...]` 片段与前后文窗口。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// 单条命中（一条消息行内的片段）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub task_id: String,
    pub msg_id: String,
    pub seq: i64,
    pub role: String,
    /// 高亮片段（命中词前后各 ~40 字符窗口；标记沿用 LiveAgent 的 `[...]`）
    pub snippet: String,
    /// 命中的 part 表 text 块（消息时间）
    pub timestamp: Option<i64>,
}

/// 按任务聚合的搜索结果
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchGroup {
    pub task_id: String,
    /// 任务标题（task payload JSON 内的 title；解析失败回退任务 id）
    pub task_title: String,
    /// 任务的工作目录（payload.project；空 = 默认工作区，UI 显示 DefaultProject 路径）
    pub task_cwd: String,
    /// 任务标题是否命中查询（标题命中排在前面）
    pub title_match: bool,
    pub task_updated_at: Option<i64>,
    pub hits: Vec<SearchHit>,
    /// 该任务命中消息总数（hits 截断前的量，供 UI 显示 N 条命中）
    pub total_hits: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub groups: Vec<SearchGroup>,
    pub total_hits: i64,
}

const SNIPPET_WINDOW: usize = 40;
const MAX_GROUPS: i64 = 20;
const MAX_HITS_PER_TASK: i64 = 5;

fn open_history_db() -> Result<Connection, String> {
    let path = crate::conversation_store::db_path_public();
    if !path.exists() {
        return Err("数据库不存在".into());
    }
    let conn = Connection::open(&path).map_err(|e| format!("Failed to open db: {}", e))?;
    Ok(conn)
}

/// 从 task payload JSON 里提取 title / project / updated_at
fn task_meta(conn: &Connection, task_id: &str) -> (String, String, Option<i64>) {
    let Ok(mut stmt) = conn.prepare("SELECT payload, updated_at FROM task WHERE id = ?1") else {
        return (task_id.to_string(), String::new(), None);
    };
    let Ok(mut rows) = stmt.query([task_id]) else {
        return (task_id.to_string(), String::new(), None);
    };
    if let Ok(Some(row)) = rows.next() {
        let payload: String = row.get(0).unwrap_or_default();
        let updated: Option<i64> = row.get(1).ok().flatten();
        let title = json_string_field(&payload, "title").unwrap_or_else(|| task_id.to_string());
        let project = json_string_field(&payload, "project").unwrap_or_default();
        return (title, project, updated);
    }
    (task_id.to_string(), String::new(), None)
}

/// 简单提取 `"key":"value"` 标量字符串字段（避免引入完整 JSON 重解析）
fn json_string_field(payload: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let start = payload.find(&needle)? + needle.len();
    let rest = &payload[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// 在一段文本里找 `query`（大小写不敏感）并生成前后窗口片段；多命中取第一处。
fn make_snippet(text: &str, query: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let q = query.to_lowercase();
    let byte_idx = lower.find(&q)?;
    // 回退到 UTF-8 字符边界（不切断多字节字符）
    let start = lower[..byte_idx]
        .char_indices()
        .rev()
        .take(SNIPPET_WINDOW)
        .last()
        .map(|(i, _)| i)
        .unwrap_or(0);
    let end_probe = (byte_idx + q.len()).min(lower.len());
    let end = lower[end_probe..]
        .char_indices()
        .take(SNIPPET_WINDOW)
        .last()
        .map(|(i, c)| end_probe + i + c.len_utf8())
        .unwrap_or(end_probe);
    let prefix = if start > 0 { "[...]" } else { "" };
    let suffix = if end < text.len() { "[...]" } else { "" };
    Some(format!("{}{}{}", prefix, &text[start..end], suffix))
}

/// 会话搜索命令：query 非空时匹配标题 + 消息全文；空 query 返回最近任务（最近 12 个）。
#[tauri::command]
pub async fn chat_history_search(query: String, limit: Option<i64>) -> Result<SearchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = query.trim();
        let conn = open_history_db()?;
        let group_limit = limit.unwrap_or(MAX_GROUPS).clamp(1, 50);

        // 空查询：返回最近任务（对齐 LiveAgent 空态显示最近会话）
        if trimmed.is_empty() {
            let mut stmt = conn
                .prepare(
                    "SELECT id, updated_at FROM task ORDER BY updated_at DESC LIMIT ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([group_limit], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
                })
                .map_err(|e| e.to_string())?;
            let mut groups = Vec::new();
            for row in rows {
                let (task_id, updated) = row.map_err(|e| e.to_string())?;
                let (title, cwd, _) = task_meta(&conn, &task_id);
                groups.push(SearchGroup {
                    task_id: task_id.clone(),
                    task_title: title,
                    task_cwd: cwd,
                    title_match: false,
                    task_updated_at: updated,
                    hits: Vec::new(),
                    total_hits: 0,
                });
            }
            return Ok(SearchResponse { groups, total_hits: 0 });
        }

        // ---- 标题命中（权重最高）----
        let like = format!("%{}%", trimmed.replace('%', "").to_lowercase());
        let mut title_matches: Vec<(String, Option<i64>)> = {
            let mut stmt = conn
                .prepare("SELECT id, updated_at FROM task")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        title_matches.retain(|(id, _)| {
            let (title, _, _) = task_meta(&conn, id);
            title.to_lowercase().contains(&like[1..like.len() - 1])
        });
        title_matches.sort_by(|a, b| b.1.unwrap_or(0).cmp(&a.1.unwrap_or(0)));
        title_matches.truncate(group_limit as usize);

        let mut groups: Vec<SearchGroup> = Vec::new();
        let mut total_hits = 0i64;
        for (task_id, updated) in &title_matches {
            let (title, cwd, _) = task_meta(&conn, task_id);
            groups.push(SearchGroup {
                task_id: task_id.clone(),
                task_title: title,
                task_cwd: cwd,
                title_match: true,
                task_updated_at: *updated,
                hits: Vec::new(),
                total_hits: 0,
            });
        }

        // ---- 消息全文命中（part 表 text/thinking 块 LIKE）----
        let pattern = format!("%{}%", trimmed.replace(['%', '_'], ""));
        let mut stmt = conn
            .prepare(
                "SELECT m.task_id, m.msg_id, m.seq, m.role, p.payload, m.started_at
                 FROM message m JOIN part p ON p.task_id = m.task_id AND p.msg_id = m.msg_id
                 WHERE p.kind IN ('text', 'thinking') AND p.payload LIKE ?1
                 ORDER BY m.started_at DESC LIMIT 500",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&pattern], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        // 按任务聚合（保持查询顺序），每任务最多 MAX_HITS_PER_TASK 条
        let mut order: Vec<String> = groups.iter().map(|g| g.task_id.clone()).collect();
        for row in rows {
            let (task_id, msg_id, seq, role, payload, started) = row.map_err(|e| e.to_string())?;
            // payload 是 {"text": "..."} / {"thinking": "..."} JSON——去掉包装取值
            let body = payload
                .split("\":\"")
                .nth(1)
                .map(|s| s.trim_end_matches("\"}").to_string())
                .unwrap_or(payload.clone());
            let Some(snippet) = make_snippet(&body, trimmed) else {
                continue;
            };
            total_hits += 1;
            if !order.contains(&task_id) {
                order.push(task_id.clone());
            }
            let group = match groups.iter_mut().find(|g| g.task_id == task_id) {
                Some(g) => g,
                None => {
                    let (title, cwd, updated) = task_meta(&conn, &task_id);
                    groups.push(SearchGroup {
                        task_id: task_id.clone(),
                        task_title: title,
                        task_cwd: cwd,
                        title_match: false,
                        task_updated_at: updated,
                        hits: Vec::new(),
                        total_hits: 0,
                    });
                    groups.last_mut().expect("just pushed")
                }
            };
            group.total_hits += 1;
            if (group.hits.len() as i64) < MAX_HITS_PER_TASK {
                group.hits.push(SearchHit {
                    task_id,
                    msg_id,
                    seq,
                    role,
                    snippet,
                    timestamp: started,
                });
            }
        }

        // 组排序：标题命中优先，其后按消息命中时间
        groups.sort_by_key(|g| if g.title_match { 0 } else { 1 });
        groups.truncate(group_limit as usize);
        let _ = order;
        Ok(SearchResponse { groups, total_hits })
    })
    .await
    .map_err(|e| e.to_string())?
}
