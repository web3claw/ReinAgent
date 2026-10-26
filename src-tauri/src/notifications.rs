//! 应用内通知收件箱（ROADMAP ⑤ v2 尾巴，Hetu InboxService 移植精简版）。
//!
//! 存储于 conversations.db：`notifications` 表即收件箱——`category_key` 唯一，
//! 同键未归档记录**合并**（正文刷新、计数+1、回未读），归档=删行。
//! 接入点：看板 blocked/failed 与自动化派发失败（前端 TS 侧 push）；
//! 铃铛徽标与面板由前端经 notify_list 轮询/事件刷新。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub(crate) const NOTIFICATIONS_SCHEMA_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS notifications (
    category_key  TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL DEFAULT '',
    link_view     TEXT,
    link_task_id  TEXT,
    count         INTEGER NOT NULL DEFAULT 1,
    unread        INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_updated ON notifications(updated_at DESC);
"#;

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(NOTIFICATIONS_SCHEMA_DDL)
        .map_err(|e| format!("notifications schema 初始化失败：{e}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRow {
    pub category_key: String,
    /// kanban | automation
    pub kind: String,
    pub title: String,
    pub body: String,
    pub link_view: Option<String>,
    pub link_task_id: Option<String>,
    pub count: i64,
    pub unread: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyPushArgs {
    /// 聚合键：同键未归档记录合并（kanban:{cardId} / automation:{automationId} / 自定义）
    pub category_key: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub link_view: Option<String>,
    #[serde(default)]
    pub link_task_id: Option<String>,
}

/// 同键合并 push（新事件刷新正文/计数+1/回未读）；返回当前总未读数
pub fn notify_push_conn(conn: &Connection, args: &NotifyPushArgs) -> Result<i64, String> {
    ensure_schema(conn)?;
    if args.category_key.trim().is_empty() || args.title.trim().is_empty() {
        return Err("categoryKey 与 title 不能为空".into());
    }
    let now = now_ms();
    conn.execute(
        "INSERT INTO notifications (category_key, kind, title, body, link_view, link_task_id, count, unread, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, ?7, ?7)
         ON CONFLICT(category_key) DO UPDATE SET
            kind = excluded.kind,
            title = excluded.title,
            body = excluded.body,
            link_view = excluded.link_view,
            link_task_id = excluded.link_task_id,
            count = notifications.count + 1,
            unread = 1,
            updated_at = excluded.updated_at",
        params![
            args.category_key.trim(),
            args.kind.trim(),
            args.title.trim(),
            args.body.trim(),
            args.link_view,
            args.link_task_id,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    notify_unread_count_conn(conn)
}

pub fn notify_list_conn(conn: &Connection, limit: usize) -> Result<Vec<NotificationRow>, String> {
    ensure_schema(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT category_key, kind, title, body, link_view, link_task_id, count, unread, created_at, updated_at
             FROM notifications ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit.clamp(1, 100) as i64], |r| {
            Ok(NotificationRow {
                category_key: r.get(0)?,
                kind: r.get(1)?,
                title: r.get(2)?,
                body: r.get(3)?,
                link_view: r.get(4)?,
                link_task_id: r.get(5)?,
                count: r.get(6)?,
                unread: r.get::<_, i64>(7)? != 0,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 归档 = 删行（v2 精简：收件箱只保留未归档聚合记录）
pub fn notify_archive_conn(conn: &Connection, category_key: &str) -> Result<i64, String> {
    ensure_schema(conn)?;
    conn.execute("DELETE FROM notifications WHERE category_key = ?1", [category_key.trim()])
        .map_err(|e| e.to_string())?;
    notify_unread_count_conn(conn)
}

pub fn notify_archive_all_conn(conn: &Connection) -> Result<i64, String> {
    ensure_schema(conn)?;
    conn.execute("DELETE FROM notifications", [])
        .map_err(|e| e.to_string())?;
    Ok(0)
}

pub fn notify_unread_count_conn(conn: &Connection) -> Result<i64, String> {
    ensure_schema(conn)?;
    conn.query_row("SELECT COUNT(*) FROM notifications WHERE unread = 1", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unread count 读取失败".into())
}

// ===== Tauri 命令 =====

#[tauri::command]
pub async fn notify_push(args: NotifyPushArgs) -> Result<i64, String> {
    let conn = crate::conversation_store::db_conn()?;
    notify_push_conn(&conn, &args)
}

#[tauri::command]
pub async fn notify_list(limit: Option<usize>) -> Result<Vec<NotificationRow>, String> {
    let conn = crate::conversation_store::db_conn()?;
    notify_list_conn(&conn, limit.unwrap_or(50))
}

#[tauri::command]
pub async fn notify_archive(category_key: String) -> Result<i64, String> {
    let conn = crate::conversation_store::db_conn()?;
    notify_archive_conn(&conn, &category_key)
}

#[tauri::command]
pub async fn notify_archive_all() -> Result<i64, String> {
    let conn = crate::conversation_store::db_conn()?;
    notify_archive_all_conn(&conn)
}
