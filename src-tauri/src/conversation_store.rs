//! 会话持久化存储（SQLite，对齐 LiveAgent 的 message/part 两表模型）。
//!
//! - `message` 表：一行一个时间线条目（TimelineEntry 的骨架字段）；
//! - `part` 表：一行一个条目的内容块（text / thinking / tool_args / tool_result），
//!   为将来的全文检索与按块查询铺路（对齐 LiveAgent 的 message/part 拆分）；
//! - `task` 表：任务元数据（标题/时间/项目/置顶/模型绑定）；
//! - `kv` 表：纯 UI 偏好（主题/语言/侧栏状态等），启动时由前端一次拉全量缓存。
//!
//! No-Fallback：任何读写错误都如实上抛，绝不静默降级。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

fn db_path() -> PathBuf {
    if let Ok(home) = std::env::var("USERPROFILE") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join(".ReinAgent").join("conversations.db");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join(".ReinAgent").join("conversations.db");
        }
    }
    PathBuf::from(".ReinAgent").join("conversations.db")
}

fn open_db() -> Result<Connection, String> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("Failed to open db: {}", e))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS message (
             task_id      TEXT NOT NULL,
             msg_id       TEXT NOT NULL,
             seq          INTEGER NOT NULL,
             role         TEXT NOT NULL,
             status       TEXT NOT NULL,
             started_at   INTEGER,
             ended_at     INTEGER,
             tool_name    TEXT,
             tool_call_id TEXT,
             is_error     INTEGER,
             truncated_by TEXT,
             error        TEXT,
             thinking_started_at INTEGER,
             thinking_duration_ms INTEGER,
             PRIMARY KEY (task_id, msg_id)
         );
         CREATE INDEX IF NOT EXISTS idx_message_seq ON message(task_id, seq);
         CREATE TABLE IF NOT EXISTS part (
             task_id    TEXT NOT NULL,
             msg_id     TEXT NOT NULL,
             part_index INTEGER NOT NULL,
             kind       TEXT NOT NULL,
             payload    TEXT NOT NULL,
             PRIMARY KEY (task_id, msg_id, part_index)
         );
         CREATE TABLE IF NOT EXISTS task (
             id         TEXT PRIMARY KEY,
             seq        INTEGER NOT NULL,
             payload    TEXT NOT NULL,
             updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS kv (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );",
    )
    .map_err(|e| format!("Failed to init schema: {}", e))?;
    Ok(conn)
}

fn db_conn() -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    static CONN: std::sync::OnceLock<Mutex<Connection>> = std::sync::OnceLock::new();
    CONN.get_or_init(|| Mutex::new(open_db().expect("Failed to open conversation db")))
        .lock()
        .map_err(|e| format!("db lock poisoned: {}", e))
}

// ---- 时间线条目（message + parts，前端序列化成一行 + 内容块） ----

#[derive(Deserialize, Serialize, Clone)]
pub struct MessagePart {
    pub part_index: i64,
    pub kind: String,
    pub payload: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct MessageRow {
    pub msg_id: String,
    pub seq: i64,
    pub role: String,
    pub status: String,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub is_error: Option<bool>,
    #[serde(default)]
    pub truncated_by: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub thinking_started_at: Option<i64>,
    #[serde(default)]
    pub thinking_duration_ms: Option<i64>,
    #[serde(default)]
    pub parts: Vec<MessagePart>,
}

/// 全量同步一个任务的对话（调用方给完整有序列表；事务内替换该任务全部行）。
/// 调用频率是轮次边界级（非每个 delta），SQLite 单任务几百行毫无压力。
#[tauri::command]
pub async fn conversation_sync(task_id: String, messages: Vec<MessageRow>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("txn failed: {}", e))?;
        tx.execute("DELETE FROM part WHERE task_id = ?1", [&task_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM message WHERE task_id = ?1", [&task_id])
            .map_err(|e| e.to_string())?;
        for m in &messages {
            tx.execute(
                "INSERT INTO message (task_id, msg_id, seq, role, status, started_at, ended_at, tool_name, tool_call_id, is_error, truncated_by, error, thinking_started_at, thinking_duration_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                rusqlite::params![
                    task_id,
                    m.msg_id,
                    m.seq,
                    m.role,
                    m.status,
                    m.started_at,
                    m.ended_at,
                    m.tool_name,
                    m.tool_call_id,
                    m.is_error,
                    m.truncated_by,
                    m.error,
                    m.thinking_started_at,
                    m.thinking_duration_ms,
                ],
            )
            .map_err(|e| e.to_string())?;
            for part in &m.parts {
                tx.execute(
                    "INSERT INTO part (task_id, msg_id, part_index, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![task_id, m.msg_id, part.part_index, part.kind, part.payload],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| format!("commit failed: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 按顺序载入一个任务的对话（含内容块，前端重组 TimelineEntry）。
#[tauri::command]
pub async fn conversation_load(task_id: String) -> Result<Vec<MessageRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        let mut rows: Vec<MessageRow> = {
            let mut stmt = conn
                .prepare(
                    "SELECT msg_id, seq, role, status, started_at, ended_at, tool_name, tool_call_id, is_error, truncated_by, error, thinking_started_at, thinking_duration_ms
                     FROM message WHERE task_id = ?1 ORDER BY seq ASC",
                )
                .map_err(|e| e.to_string())?;
            let mapped = stmt
                .query_map([&task_id], |row| {
                    Ok(MessageRow {
                        msg_id: row.get(0)?,
                        seq: row.get(1)?,
                        role: row.get(2)?,
                        status: row.get(3)?,
                        started_at: row.get(4)?,
                        ended_at: row.get(5)?,
                        tool_name: row.get(6)?,
                        tool_call_id: row.get(7)?,
                        is_error: row.get(8)?,
                        truncated_by: row.get(9)?,
                        error: row.get(10)?,
                        thinking_started_at: row.get(11)?,
                        thinking_duration_ms: row.get(12)?,
                        parts: Vec::new(),
                    })
                })
                .map_err(|e| e.to_string())?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };

        let mut parts_by_msg: HashMap<String, Vec<MessagePart>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT msg_id, part_index, kind, payload FROM part WHERE task_id = ?1 ORDER BY part_index ASC",
                )
                .map_err(|e| e.to_string())?;
            let parts: Vec<(String, i64, String, String)> = stmt
                .query_map([&task_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            for (msg_id, part_index, kind, payload) in parts {
                parts_by_msg.entry(msg_id).or_default().push(MessagePart {
                    part_index,
                    kind,
                    payload,
                });
            }
        }

        for row in &mut rows {
            if let Some(parts) = parts_by_msg.remove(&row.msg_id) {
                row.parts = parts;
            }
        }
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除一个任务的全部对话数据。
#[tauri::command]
pub async fn conversation_delete(task_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        conn.execute("DELETE FROM part WHERE task_id = ?1", [&task_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM message WHERE task_id = ?1", [&task_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- 任务元数据 ----

#[derive(Deserialize, Serialize)]
pub struct TaskRow {
    pub id: String,
    pub seq: i64,
    pub payload: String,
    pub updated_at: i64,
}

/// 全量同步任务元数据列表（任务数量小，直接替换）。
#[tauri::command]
pub async fn task_sync(tasks: Vec<TaskRow>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("txn failed: {}", e))?;
        tx.execute("DELETE FROM task", [])
            .map_err(|e| e.to_string())?;
        for t in &tasks {
            tx.execute(
                "INSERT INTO task (id, seq, payload, updated_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![t.id, t.seq, t.payload, t.updated_at],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| format!("commit failed: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 载入全部任务元数据（按 seq = 创建顺序）。
#[tauri::command]
pub async fn task_list() -> Result<Vec<TaskRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        let mut stmt = conn
            .prepare("SELECT id, seq, payload, updated_at FROM task ORDER BY seq ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(TaskRow {
                    id: row.get(0)?,
                    seq: row.get(1)?,
                    payload: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- UI 偏好（kv） ----

#[derive(Deserialize, Serialize)]
pub struct KvPair {
    pub key: String,
    pub value: String,
}

/// 启动时一次拉全量 kv（前端缓存在内存同步读）。
#[tauri::command]
pub async fn kv_get_all() -> Result<Vec<KvPair>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        let mut stmt = conn
            .prepare("SELECT key, value FROM kv")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(KvPair {
                    key: row.get(0)?,
                    value: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 批量写入 kv。
#[tauri::command]
pub async fn kv_set_many(pairs: Vec<KvPair>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("txn failed: {}", e))?;
        for pair in &pairs {
            tx.execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![pair.key, pair.value],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| format!("commit failed: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
