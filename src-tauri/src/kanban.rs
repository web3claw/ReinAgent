//! 看板式 Agent 任务（ROADMAP ⑤，对标 Hetu KanbanTask 体系）：
//! 卡片 = 七列状态机 + 持久会话绑定；拖进 Todo 触发无人值守执行（复用
//! conversationPool，不自建执行器——池已解决无 UI 执行/持久化/审批/终态事件，
//! 本模块只管「状态机迁移 + 每卡单 run 查重 + run 记账」三件事）。
//!
//! 存储照 automations 先例：conversations.db 同库 + 模块独立连接 + 幂等 DDL。
//! 三表：kanban_cards（卡片+状态机）/ kanban_card_comments（评论流=简报与回灌
//! 源）/ kanban_runs（执行记账；`UNIQUE(card_id) WHERE status='running'` 部分
//! 唯一索引兜底「每卡同时最多 1 run」）。
//!
//! 「卡片=持久会话」（用户拍板）：卡片绑定固定 task_id，执行=发首轮，评论=
//! 下一轮 user 消息续跑；ask_user 挂起（pendingApproval）由 TS 侧
//! subscribeTaskTerminal 事件驱动转 Blocked，评论/答案回流 resolveApproval 续跑。

use std::{
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

// ==================== 常量与状态机 ====================

pub const KANBAN_COLUMNS: [&str; 7] = [
    "Backlog",
    "Todo",
    "InProgress",
    "InReview",
    "Blocked",
    "Done",
    "Archived",
];

pub const KANBAN_PRIORITIES: [&str; 4] = ["low", "medium", "high", "urgent"];

/// 状态机迁移白名单（用户拍板照 Hetu；非法迁移后端拒绝）。
/// Todo 是唯一自动化触发点；InReview/Blocked 评论打回 Todo；Done 只能归档。
const COLUMN_TRANSITIONS: &[(&str, &[&str])] = &[
    ("Backlog", &["Todo", "Archived"]),
    ("Todo", &["InProgress", "Backlog", "Archived"]),
    ("InProgress", &["InReview", "Blocked", "Backlog"]),
    ("InReview", &["Done", "InProgress", "Blocked", "Todo"]),
    ("Blocked", &["Todo", "InProgress"]),
    ("Done", &["Archived"]),
    ("Archived", &["Backlog"]),
];

pub fn is_valid_transition(from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }
    COLUMN_TRANSITIONS
        .iter()
        .find(|(f, _)| *f == from)
        .map(|(_, targets)| targets.contains(&to))
        .unwrap_or(false)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ==================== DTO ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanCard {
    pub card_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub column: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_priority() -> String {
    "medium".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanComment {
    pub id: i64,
    pub card_id: String,
    pub author: String,
    pub body: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanRun {
    pub run_id: String,
    pub card_id: String,
    pub task_id: String,
    pub trigger: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanCardCreateArgs {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub priority: String,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub model_id: String,
    /// 创建时所在列（缺省 Backlog；拖到 Todo 创建也允许——创建即触发由 TS 决定）
    #[serde(default)]
    pub column: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanCardMoveArgs {
    pub card_id: String,
    pub to_column: String,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanCardUpdateArgs {
    pub card_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanCommentAddArgs {
    pub card_id: String,
    pub author: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanRunStartArgs {
    pub card_id: String,
    pub task_id: String,
    /// 'todo' | 'comment' | 'manual'
    pub trigger: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanRunStartResult {
    pub run_id: String,
    /// false = 该卡已有 running run（每卡单 run 查重命中），本次被拒绝
    pub started: bool,
}

// ==================== Store =====================

fn db_path() -> std::path::PathBuf {
    // 测试隔离：KANBAN_DB_PATH 覆盖（gate 单测不碰真实 conversations.db——
    // dev 实例持有 WAL 连接时测试会卡在 busy_timeout 上，本轮实测踩中）
    if let Ok(override_path) = std::env::var("REINAGENT_KANBAN_TEST_DB") {
        if !override_path.trim().is_empty() {
            return std::path::PathBuf::from(override_path);
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        if !home.trim().is_empty() {
            return std::path::PathBuf::from(home).join(".ReinAgent").join("conversations.db");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return std::path::PathBuf::from(home).join(".ReinAgent").join("conversations.db");
        }
    }
    std::path::PathBuf::from(".ReinAgent").join("conversations.db")
}

fn open_db() -> Result<Connection, String> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("打开看板库失败: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS kanban_cards (
             card_id        TEXT PRIMARY KEY,
             title          TEXT NOT NULL,
             description    TEXT NOT NULL DEFAULT '',
             column         TEXT NOT NULL CHECK (column IN ('Backlog','Todo','InProgress','InReview','Blocked','Done','Archived')),
             priority       TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
             workspace_path TEXT NOT NULL DEFAULT '',
             provider_id    TEXT NOT NULL DEFAULT '',
             model_id       TEXT NOT NULL DEFAULT '',
             task_id        TEXT NOT NULL DEFAULT '',
             sort_order     INTEGER NOT NULL DEFAULT 0,
             created_at     INTEGER NOT NULL,
             updated_at     INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_kanban_cards_column
             ON kanban_cards(column, sort_order);
         CREATE TABLE IF NOT EXISTS kanban_card_comments (
             id         INTEGER PRIMARY KEY AUTOINCREMENT,
             card_id    TEXT NOT NULL,
             author     TEXT NOT NULL CHECK (author IN ('user','agent','system')),
             body       TEXT NOT NULL,
             created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_kanban_comments_card
             ON kanban_card_comments(card_id, created_at);
         CREATE TABLE IF NOT EXISTS kanban_runs (
             run_id     TEXT PRIMARY KEY,
             card_id    TEXT NOT NULL,
             task_id    TEXT NOT NULL DEFAULT '',
             trigger    TEXT NOT NULL DEFAULT 'manual',
             status     TEXT NOT NULL,
             error      TEXT,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_kanban_runs_card
             ON kanban_runs(card_id, created_at);
         ",
    )
    .map_err(|e| format!("初始化看板表失败: {e}"))?;
    // 每卡同时最多 1 run：部分唯一索引（单独 batch——旧库 ALTER 场景幂等追加）
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_kanban_runs_active
             ON kanban_runs(card_id) WHERE status = 'running';",
    )
    .map_err(|e| format!("初始化看板单 run 索引失败: {e}"))?;
    Ok(conn)
}

/// 生产全局连接（单例）。
static CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

fn db_conn() -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    CONN.get_or_init(|| Mutex::new(open_db().expect("Failed to open kanban db")))
        .lock()
        .map_err(|e| format!("kanban db 锁失败: {e}"))
}

fn validate_column(value: &str) -> Result<String, String> {
    if KANBAN_COLUMNS.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(format!(
            "非法看板列：{value}（允许：{}）",
            KANBAN_COLUMNS.join("/")
        ))
    }
}

fn validate_priority(value: &str) -> Result<String, String> {
    if KANBAN_PRIORITIES.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(format!("非法优先级：{value}"))
    }
}

fn row_to_card(row: &rusqlite::Row<'_>) -> rusqlite::Result<KanbanCard> {
    Ok(KanbanCard {
        card_id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        column: row.get(3)?,
        priority: row.get(4)?,
        workspace_path: row.get(5)?,
        provider_id: row.get(6)?,
        model_id: row.get(7)?,
        task_id: row.get(8)?,
        sort_order: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn card_exists(conn: &Connection, card_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE card_id = ?1)",
        [card_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|v| v != 0)
    .map_err(|e| format!("查询卡片失败: {e}"))
}

// ==================== Store 方法 =====================

pub struct KanbanStore;

impl KanbanStore {
    pub fn create_card(args: KanbanCardCreateArgs) -> Result<KanbanCard, String> {
        let title = args.title.trim().to_string();
        if title.is_empty() {
            return Err("卡片标题不能为空".to_string());
        }
        let column = if args.column.is_empty() {
            "Backlog".to_string()
        } else {
            validate_column(&args.column)?
        };
        let priority = if args.priority.is_empty() {
            "medium".to_string()
        } else {
            validate_priority(&args.priority)?
        };
        let card_id = format!("kanban-{}-{}", now_ms(), uuid::Uuid::new_v4().simple().to_string()[..6].to_lowercase());
        let now = now_ms();
        let conn = db_conn()?;
        conn.execute(
            "INSERT INTO kanban_cards (card_id, title, description, column, priority, workspace_path, provider_id, model_id, task_id, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '', 0, ?9, ?9)",
            params![
                card_id,
                title,
                args.description.trim(),
                column,
                priority,
                args.workspace_path.trim(),
                args.provider_id.trim(),
                args.model_id.trim(),
                now
            ],
        )
        .map_err(|e| format!("创建卡片失败: {e}"))?;
        drop(conn);
        Self::get_card(&card_id)
    }

    pub fn get_card(card_id: &str) -> Result<KanbanCard, String> {
        let conn = db_conn()?;
        conn.query_row(
            "SELECT card_id, title, description, column, priority, workspace_path, provider_id, model_id, task_id, sort_order, created_at, updated_at
             FROM kanban_cards WHERE card_id = ?1",
            [card_id],
            row_to_card,
        )
        .optional()
        .map_err(|e| format!("读取卡片失败: {e}"))?
        .ok_or_else(|| format!("卡片不存在: {card_id}"))
    }

    pub fn list_cards() -> Result<Vec<KanbanCard>, String> {
        let conn = db_conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT card_id, title, description, column, priority, workspace_path, provider_id, model_id, task_id, sort_order, created_at, updated_at
                 FROM kanban_cards ORDER BY sort_order ASC, updated_at DESC",
            )
            .map_err(|e| format!("列出卡片失败: {e}"))?;
        let mapped = stmt
            .query_map([], row_to_card)
            .map_err(|e| format!("列出卡片失败: {e}"))?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row.map_err(|e| format!("读取卡片行失败: {e}"))?);
        }
        Ok(out)
    }

    /// 列间移动（迁移白名单校验）+ 可选排序。
    pub fn move_card(args: KanbanCardMoveArgs) -> Result<KanbanCard, String> {
        let to_column = validate_column(&args.to_column)?;
        let conn = db_conn()?;
        let current: String = conn
            .query_row(
                "SELECT column FROM kanban_cards WHERE card_id = ?1",
                [&args.card_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("查询卡片失败: {e}"))?
            .ok_or_else(|| format!("卡片不存在: {}", args.card_id))?;
        if !is_valid_transition(&current, &to_column) {
            return Err(format!("非法状态迁移: {current} → {to_column}"));
        }
        let sort_order = args.sort_order.unwrap_or(0);
        conn.execute(
            "UPDATE kanban_cards SET column = ?2, sort_order = ?3, updated_at = ?4 WHERE card_id = ?1",
            params![args.card_id, to_column, sort_order, now_ms()],
        )
        .map_err(|e| format!("移动卡片失败: {e}"))?;
        drop(conn);
        Self::get_card(&args.card_id)
    }

    pub fn update_fields(args: KanbanCardUpdateArgs) -> Result<KanbanCard, String> {
        let conn = db_conn()?;
        let now = now_ms();
        if let Some(title) = args.title.as_deref() {
            let title = title.trim();
            if title.is_empty() {
                return Err("卡片标题不能为空".to_string());
            }
            conn.execute(
                "UPDATE kanban_cards SET title = ?2, updated_at = ?3 WHERE card_id = ?1",
                params![args.card_id, title, now],
            )
            .map_err(|e| format!("更新标题失败: {e}"))?;
        }
        if let Some(description) = args.description.as_deref() {
            conn.execute(
                "UPDATE kanban_cards SET description = ?2, updated_at = ?3 WHERE card_id = ?1",
                params![args.card_id, description, now],
            )
            .map_err(|e| format!("更新描述失败: {e}"))?;
        }
        if let Some(priority) = args.priority.as_deref() {
            let priority = validate_priority(priority)?;
            conn.execute(
                "UPDATE kanban_cards SET priority = ?2, updated_at = ?3 WHERE card_id = ?1",
                params![args.card_id, priority, now],
            )
            .map_err(|e| format!("更新优先级失败: {e}"))?;
        }
        for (label, field, sql) in [
            ("工作区", &args.workspace_path, "workspace_path"),
            ("服务商", &args.provider_id, "provider_id"),
            ("模型", &args.model_id, "model_id"),
        ] {
            if let Some(value) = field.as_deref() {
                conn.execute(
                    &format!("UPDATE kanban_cards SET {sql} = ?2, updated_at = ?3 WHERE card_id = ?1"),
                    params![args.card_id, value.trim(), now],
                )
                .map_err(|e| format!("更新{label}失败: {e}"))?;
            }
        }
        drop(conn);
        Self::get_card(&args.card_id)
    }

    pub fn delete_card(card_id: &str) -> Result<(), String> {
        let conn = db_conn()?;
        if !card_exists(&conn, card_id)? {
            return Ok(());
        }
        conn.execute("DELETE FROM kanban_card_comments WHERE card_id = ?1", [card_id])
            .map_err(|e| format!("删除评论失败: {e}"))?;
        conn.execute("DELETE FROM kanban_runs WHERE card_id = ?1", [card_id])
            .map_err(|e| format!("删除运行记录失败: {e}"))?;
        conn.execute("DELETE FROM kanban_cards WHERE card_id = ?1", [card_id])
            .map_err(|e| format!("删除卡片失败: {e}"))?;
        Ok(())
    }

    pub fn set_task_id(card_id: &str, task_id: &str) -> Result<(), String> {
        let conn = db_conn()?;
        conn.execute(
            "UPDATE kanban_cards SET task_id = ?2, updated_at = ?3 WHERE card_id = ?1",
            params![card_id, task_id, now_ms()],
        )
        .map_err(|e| format!("绑定会话失败: {e}"))?;
        Ok(())
    }

    // ---------------- 评论 ----------------

    pub fn add_comment(args: KanbanCommentAddArgs) -> Result<KanbanComment, String> {
        let body = args.body.trim().to_string();
        if body.is_empty() {
            return Err("评论内容不能为空".to_string());
        }
        let author = match args.author.as_str() {
            "user" | "agent" | "system" => args.author.as_str(),
            _ => return Err(format!("非法评论作者: {}", args.author)),
        };
        let conn = db_conn()?;
        if !card_exists(&conn, &args.card_id)? {
            return Err(format!("卡片不存在: {}", args.card_id));
        }
        let now = now_ms();
        conn.execute(
            "INSERT INTO kanban_card_comments (card_id, author, body, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![args.card_id, author, body, now],
        )
        .map_err(|e| format!("添加评论失败: {e}"))?;
        conn.execute(
            "UPDATE kanban_cards SET updated_at = ?2 WHERE card_id = ?1",
            params![args.card_id, now],
        )
        .map_err(|e| format!("更新卡片时间失败: {e}"))?;
        let id = conn.last_insert_rowid();
        Ok(KanbanComment {
            id,
            card_id: args.card_id,
            author: author.to_string(),
            body,
            created_at: now,
        })
    }

    pub fn list_comments(card_id: &str) -> Result<Vec<KanbanComment>, String> {
        let conn = db_conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, card_id, author, body, created_at FROM kanban_card_comments
                 WHERE card_id = ?1 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| format!("列出评论失败: {e}"))?;
        let mapped = stmt
            .query_map([card_id], |row| {
                Ok(KanbanComment {
                    id: row.get(0)?,
                    card_id: row.get(1)?,
                    author: row.get(2)?,
                    body: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| format!("列出评论失败: {e}"))?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row.map_err(|e| format!("读取评论行失败: {e}"))?);
        }
        Ok(out)
    }

    // ---------------- Run 记账 ----------------

    /// 启动一次执行（每卡单 run：部分唯一索引兜底，冲突=已拒绝）。
    pub fn run_start(args: KanbanRunStartArgs) -> Result<KanbanRunStartResult, String> {
        let trigger = match args.trigger.as_str() {
            "todo" | "comment" | "manual" => args.trigger.as_str(),
            _ => return Err(format!("非法触发类型: {}", args.trigger)),
        };
        let conn = db_conn()?;
        if !card_exists(&conn, &args.card_id)? {
            return Err(format!("卡片不存在: {}", args.card_id));
        }
        let run_id = format!("kanban-run-{}-{}", now_ms(), uuid::Uuid::new_v4().simple().to_string()[..6].to_lowercase());
        let now = now_ms();
        let inserted = conn
            .execute(
                "INSERT INTO kanban_runs (run_id, card_id, task_id, trigger, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?5)",
                params![run_id, args.card_id, args.task_id, trigger, now],
            )
            .map_err(|e| {
                if format!("{e}").contains("UNIQUE constraint failed") {
                    format!("该卡片已有正在执行的 run（每卡同时最多 1 个）: {}", args.card_id)
                } else {
                    format!("启动 run 失败: {e}")
                }
            })?;
        Ok(KanbanRunStartResult {
            run_id,
            started: inserted > 0,
        })
    }

    pub fn run_finish(run_id: &str, status: &str, error: Option<String>) -> Result<(), String> {
        let status = match status {
            "succeeded" | "failed" | "blocked" | "stopped" => status,
            _ => return Err(format!("非法 run 终态: {status}")),
        };
        let conn = db_conn()?;
        conn.execute(
            "UPDATE kanban_runs SET status = ?2, error = ?3, updated_at = ?4 WHERE run_id = ?1",
            params![run_id, status, error, now_ms()],
        )
        .map_err(|e| format!("结束 run 失败: {e}"))?;
        Ok(())
    }

    pub fn run_list(card_id: &str) -> Result<Vec<KanbanRun>, String> {
        let conn = db_conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT run_id, card_id, task_id, trigger, status, error, created_at, updated_at
                 FROM kanban_runs WHERE card_id = ?1 ORDER BY created_at DESC, rowid DESC",
            )
            .map_err(|e| format!("列出 run 失败: {e}"))?;
        let mapped = stmt
            .query_map([card_id], |row| {
                Ok(KanbanRun {
                    run_id: row.get(0)?,
                    card_id: row.get(1)?,
                    task_id: row.get(2)?,
                    trigger: row.get(3)?,
                    status: row.get(4)?,
                    error: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(|e| format!("列出 run 失败: {e}"))?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row.map_err(|e| format!("读取 run 行失败: {e}"))?);
        }
        Ok(out)
    }
}

/// 启动恢复：running 残留收敛为 stopped（照 automation mark_stale_running_runs
/// ——应用关闭 = 运行中断，卡片可重新触发）。
pub fn recover_stale_runs() -> Result<usize, String> {
        let conn = db_conn()?;
        let recovered = conn
            .execute(
                "UPDATE kanban_runs SET status = 'stopped', error = '应用重启，运行中断', updated_at = ?1
                 WHERE status = 'running'",
                params![now_ms()],
            )
            .map_err(|e| format!("恢复残留 run 失败: {e}"))?;
        Ok(recovered)
}

// ==================== Tauri 命令 =====================

async fn kanban_spawn_blocking<T, F>(command: &str, task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("{command} join 失败：{e}"))?
}

#[tauri::command]
pub async fn kanban_card_create(args: KanbanCardCreateArgs) -> Result<KanbanCard, String> {
    kanban_spawn_blocking("kanban_card_create", move || KanbanStore::create_card(args)).await
}

#[tauri::command]
pub async fn kanban_card_list() -> Result<Vec<KanbanCard>, String> {
    kanban_spawn_blocking("kanban_card_list", move || KanbanStore::list_cards()).await
}

#[tauri::command]
pub async fn kanban_card_get(card_id: String) -> Result<KanbanCard, String> {
    kanban_spawn_blocking("kanban_card_get", move || KanbanStore::get_card(&card_id)).await
}

#[tauri::command]
pub async fn kanban_card_move(args: KanbanCardMoveArgs) -> Result<KanbanCard, String> {
    kanban_spawn_blocking("kanban_card_move", move || KanbanStore::move_card(args)).await
}

#[tauri::command]
pub async fn kanban_card_update(args: KanbanCardUpdateArgs) -> Result<KanbanCard, String> {
    kanban_spawn_blocking("kanban_card_update", move || KanbanStore::update_fields(args)).await
}

#[tauri::command]
pub async fn kanban_card_delete(card_id: String) -> Result<(), String> {
    kanban_spawn_blocking("kanban_card_delete", move || KanbanStore::delete_card(&card_id)).await
}

#[tauri::command]
pub async fn kanban_card_set_task(card_id: String, task_id: String) -> Result<(), String> {
    kanban_spawn_blocking("kanban_card_set_task", move || {
        KanbanStore::set_task_id(&card_id, &task_id)
    })
    .await
}

#[tauri::command]
pub async fn kanban_comment_add(args: KanbanCommentAddArgs) -> Result<KanbanComment, String> {
    kanban_spawn_blocking("kanban_comment_add", move || KanbanStore::add_comment(args)).await
}

#[tauri::command]
pub async fn kanban_comment_list(card_id: String) -> Result<Vec<KanbanComment>, String> {
    kanban_spawn_blocking("kanban_comment_list", move || KanbanStore::list_comments(&card_id)).await
}

#[tauri::command]
pub async fn kanban_run_start(args: KanbanRunStartArgs) -> Result<KanbanRunStartResult, String> {
    kanban_spawn_blocking("kanban_run_start", move || KanbanStore::run_start(args)).await
}

#[tauri::command]
pub async fn kanban_run_finish(run_id: String, status: String, error: Option<String>) -> Result<(), String> {
    kanban_spawn_blocking("kanban_run_finish", move || KanbanStore::run_finish(&run_id, &status, error)).await
}

#[tauri::command]
pub async fn kanban_run_list(card_id: String) -> Result<Vec<KanbanRun>, String> {
    kanban_spawn_blocking("kanban_run_list", move || KanbanStore::run_list(&card_id)).await
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    // kanban 表在 conversations.db（db_path 走真实 HOME）——测试用唯一 card_id
    // 隔离数据，结束后删除；不走临时 HOME（conversation_store 同库共享）。
    /// 串行锁：测试共享真实 conversations.db（dev 关闭时无争用），
    /// 并发写同库会撞 WAL busy——本组测试全程持锁。
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = KanbanStore::delete_card(&self.0);
        }
    }

    fn create_card(title: &str, column: &str) -> (String, Cleanup) {
        let card = KanbanStore::create_card(KanbanCardCreateArgs {
            title: title.to_string(),
            description: String::new(),
            priority: String::new(),
            workspace_path: String::new(),
            provider_id: String::new(),
            model_id: String::new(),
            column: column.to_string(),
        })
        .expect("create card");
        (card.card_id.clone(), Cleanup(card.card_id))
    }

    #[test]
    fn transitions_valid_and_invalid() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // 白名单内
        assert!(is_valid_transition("Backlog", "Todo"));
        assert!(is_valid_transition("Todo", "InProgress"));
        assert!(is_valid_transition("InProgress", "InReview"));
        assert!(is_valid_transition("InReview", "Done"));
        assert!(is_valid_transition("InReview", "Todo")); // 重跑
        assert!(is_valid_transition("Blocked", "Todo"));
        assert!(is_valid_transition("Done", "Archived"));
        assert!(is_valid_transition("Archived", "Backlog"));
        // 白名单外（非法）
        assert!(!is_valid_transition("Backlog", "Done"));
        assert!(!is_valid_transition("Todo", "Done"));
        assert!(!is_valid_transition("Done", "InProgress"));
        assert!(!is_valid_transition("Blocked", "Done"));
        assert!(!is_valid_transition("Archived", "Done"));
    }

    #[test]
    fn create_move_and_invalid_transition_rejected() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (card_id, _cleanup) = create_card("迁移测试卡", "Backlog");
        // 合法：Backlog → Todo
        let moved = KanbanStore::move_card(KanbanCardMoveArgs {
            card_id: card_id.clone(),
            to_column: "Todo".to_string(),
            sort_order: None,
        })
        .expect("legal move");
        assert_eq!(moved.column, "Todo");
        // 非法：Todo → Done（必须经 InReview）
        let err = KanbanStore::move_card(KanbanCardMoveArgs {
            card_id: card_id.clone(),
            to_column: "Done".to_string(),
            sort_order: None,
        })
        .expect_err("illegal move must fail");
        assert!(err.contains("非法状态迁移"), "实际：{err}");
        // 非法列名
        let err = KanbanStore::move_card(KanbanCardMoveArgs {
            card_id: card_id.clone(),
            to_column: "Hacking".to_string(),
            sort_order: None,
        })
        .expect_err("bad column must fail");
        assert!(err.contains("非法看板列"), "实际：{err}");
    }

    #[test]
    fn single_run_per_card_enforced() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (card_id, _cleanup) = create_card("单 run 测试卡", "Todo");
        let first = KanbanStore::run_start(KanbanRunStartArgs {
            card_id: card_id.clone(),
            task_id: "task-a".to_string(),
            trigger: "todo".to_string(),
        })
        .expect("first run");
        assert!(first.started);
        // 第二个 running run → 拒绝
        let err = KanbanStore::run_start(KanbanRunStartArgs {
            card_id: card_id.clone(),
            task_id: "task-b".to_string(),
            trigger: "manual".to_string(),
        })
        .expect_err("second run must conflict");
        assert!(err.contains("每卡同时最多"), "实际：{err}");
        // 结束后可再启
        KanbanStore::run_finish(&first.run_id, "succeeded", None).expect("finish");
        let second = KanbanStore::run_start(KanbanRunStartArgs {
            card_id: card_id.clone(),
            task_id: "task-b".to_string(),
            trigger: "comment".to_string(),
        })
        .expect("second run after finish");
        assert!(second.started);
        // 非法终态
        let err = KanbanStore::run_finish(&second.run_id, "running", None).expect_err("bad status");
        assert!(err.contains("非法 run 终态"), "实际：{err}");
        KanbanStore::run_finish(&second.run_id, "failed", Some("boom".into())).expect("finish 2");
        let runs = KanbanStore::run_list(&card_id).expect("run list");
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].status, "failed", "最新在前");
    }

    #[test]
    fn comments_crud_and_card_lifecycle() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (card_id, _cleanup) = create_card("评论测试卡", "InReview");
        let c1 = KanbanStore::add_comment(KanbanCommentAddArgs {
            card_id: card_id.clone(),
            author: "user".to_string(),
            body: "请补充性能数据".to_string(),
        })
        .expect("comment 1");
        let c2 = KanbanStore::add_comment(KanbanCommentAddArgs {
            card_id: card_id.clone(),
            author: "agent".to_string(),
            body: "已补充完毕".to_string(),
        })
        .expect("comment 2");
        assert!(c1.id < c2.id);
        let err = KanbanStore::add_comment(KanbanCommentAddArgs {
            card_id: card_id.clone(),
            author: "robot".to_string(),
            body: "x".to_string(),
        })
        .expect_err("bad author must fail");
        assert!(err.contains("非法评论作者"), "实际：{err}");
        let err = KanbanStore::add_comment(KanbanCommentAddArgs {
            card_id: card_id.clone(),
            author: "user".to_string(),
            body: "   ".to_string(),
        })
        .expect_err("empty body must fail");
        assert!(err.contains("不能为空"), "实际：{err}");
        let comments = KanbanStore::list_comments(&card_id).expect("list");
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].author, "user");
        // 删除卡片连带评论清理
        KanbanStore::delete_card(&card_id).expect("delete");
        assert!(KanbanStore::list_comments(&card_id).expect("list").is_empty());
    }
}
