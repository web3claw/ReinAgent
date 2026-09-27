//! 自动化定时任务（一期）——对齐 ZCode automations 模型：
//! - `automations` / `automation_runs` 两表（存于 `~/.ReinAgent/conversations.db`，与
//!   会话库同文件，WAL 允许同进程多连接）；
//! - `scheduleRule` 结构化规则为调度权威（minute/hourly/daily/weekly/monthly），
//!   `cronExpr` 仅作展示兼容；
//! - 调度 = 应用内线程每 20s 轮询到期任务：claim（写 run 行 + 推进 next_run_at）后
//!   经 `automation-due` 事件派发给前端，由前端会话池创建任务并发送提示词；
//! - 运行结束由前端回报 `automation_run_finished`（应用重启时残留的 running 一律
//!   收敛为 stopped）。

use chrono::{Datelike, Duration as ChronoDuration, Local, TimeZone};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

// ---------------------------------------------------------------------------
// DTO（serde camelCase，与前端 TS 类型一一对应）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRule {
    /// minute | hourly | daily | weekly | monthly
    pub unit: String,
    pub interval: i64,
    pub hour: i64,
    pub minute: i64,
    /// 0=周日 … 6=周六（weekly / 工作日预设用）
    #[serde(default)]
    pub weekdays: Option<Vec<i64>>,
    /// 1-31（monthly 用）
    #[serde(default)]
    pub month_days: Option<Vec<i64>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub automation_id: String,
    pub title: String,
    pub cron_expr: String,
    pub schedule_rule: ScheduleRule,
    pub prompt: String,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub workspace_path: Option<String>,
    pub enabled: bool,
    pub lifecycle_status: String,
    pub run_count: i64,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub run_id: String,
    pub automation_id: String,
    pub scheduled_at: Option<i64>,
    /// schedule | manual
    pub trigger: String,
    /// running | succeeded | failed | stopped
    pub status: String,
    pub task_id: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 创建/更新的入参（命令参数形态）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationUpsert {
    pub title: String,
    pub prompt: String,
    pub schedule_rule: ScheduleRule,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub workspace_path: Option<String>,
    pub enabled: bool,
}

/// 调度派发负载（`automation-due` 事件 payload；run_now 命令的返回值同形）
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDuePayload {
    pub run_id: String,
    pub automation_id: String,
    pub title: String,
    pub prompt: String,
    pub workspace_path: Option<String>,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 存储（独立连接打开 conversations.db；表结构 v1）
// ---------------------------------------------------------------------------

fn db_path() -> std::path::PathBuf {
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
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("Failed to open db: {}", e))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS automations (
             automation_id  TEXT PRIMARY KEY,
             title          TEXT NOT NULL,
             cron_expr      TEXT NOT NULL DEFAULT '',
             schedule_rule  TEXT NOT NULL,
             prompt         TEXT NOT NULL,
             model_provider TEXT,
             model_id       TEXT,
             workspace_path TEXT,
             enabled        INTEGER NOT NULL DEFAULT 1,
             lifecycle_status TEXT NOT NULL DEFAULT 'active',
             run_count      INTEGER NOT NULL DEFAULT 0,
             next_run_at    INTEGER,
             last_run_at    INTEGER,
             last_error     TEXT,
             created_at     INTEGER NOT NULL,
             updated_at     INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_automations_enabled
             ON automations(enabled, next_run_at);
         CREATE TABLE IF NOT EXISTS automation_runs (
             run_id        TEXT PRIMARY KEY,
             automation_id TEXT NOT NULL,
             scheduled_at  INTEGER,
             trigger       TEXT NOT NULL,
             status        TEXT NOT NULL,
             task_id       TEXT,
             error         TEXT,
             created_at    INTEGER NOT NULL,
             updated_at    INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_runs_automation
             ON automation_runs(automation_id, created_at);",
    )
    .map_err(|e| format!("Failed to init automation schema: {}", e))?;
    Ok(conn)
}

fn db_conn() -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    static CONN: std::sync::OnceLock<Mutex<Connection>> = std::sync::OnceLock::new();
    CONN.get_or_init(|| Mutex::new(open_db().expect("Failed to open automation db")))
        .lock()
        .map_err(|e| format!("db lock poisoned: {}", e))
}

fn rule_from_json(json: &str) -> Result<ScheduleRule, String> {
    serde_json::from_str(json).map_err(|e| format!("schedule rule parse failed: {}", e))
}

fn rule_to_json(rule: &ScheduleRule) -> String {
    serde_json::to_string(rule).unwrap_or_else(|_| "{}".into())
}

fn row_to_automation(row: &rusqlite::Row) -> rusqlite::Result<Automation> {
    let rule_json: String = row.get("schedule_rule")?;
    Ok(Automation {
        automation_id: row.get("automation_id")?,
        title: row.get("title")?,
        cron_expr: row.get("cron_expr")?,
        schedule_rule: serde_json::from_str(&rule_json).unwrap_or(ScheduleRule {
            unit: "daily".into(),
            interval: 1,
            hour: 9,
            minute: 0,
            weekdays: None,
            month_days: None,
        }),
        prompt: row.get("prompt")?,
        model_provider: row.get("model_provider")?,
        model_id: row.get("model_id")?,
        workspace_path: row.get("workspace_path")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        lifecycle_status: row.get("lifecycle_status")?,
        run_count: row.get("run_count")?,
        next_run_at: row.get("next_run_at")?,
        last_run_at: row.get("last_run_at")?,
        last_error: row.get("last_error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const AUTOMATION_COLUMNS: &str =
    "automation_id, title, cron_expr, schedule_rule, prompt, model_provider, model_id, \
     workspace_path, enabled, lifecycle_status, run_count, next_run_at, last_run_at, \
     last_error, created_at, updated_at";

fn get_automation(conn: &Connection, automation_id: &str) -> Result<Option<Automation>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {AUTOMATION_COLUMNS} FROM automations WHERE automation_id = ?1"
        ))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([automation_id], row_to_automation)
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

fn insert_automation(conn: &Connection, automation: &Automation) -> Result<(), String> {
    conn.execute(
        &format!(
            "INSERT INTO automations ({AUTOMATION_COLUMNS})
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)"
        ),
        rusqlite::params![
            automation.automation_id,
            automation.title,
            automation.cron_expr,
            rule_to_json(&automation.schedule_rule),
            automation.prompt,
            automation.model_provider,
            automation.model_id,
            automation.workspace_path,
            automation.enabled as i64,
            automation.lifecycle_status,
            automation.run_count,
            automation.next_run_at,
            automation.last_run_at,
            automation.last_error,
            automation.created_at,
            automation.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 调度计算（scheduleRule 权威；纯函数便于单测）
// ---------------------------------------------------------------------------

/// 由 scheduleRule 计算 cron 显示串（5 段；仅展示，调度以 rule 为准）。
pub fn rule_to_cron_display(rule: &ScheduleRule) -> String {
    let m = rule.minute.clamp(0, 59);
    let h = rule.hour.clamp(0, 23);
    let i = rule.interval.max(1);
    match rule.unit.as_str() {
        "minute" => format!("*/{i} * * * *"),
        "hourly" => format!("{m} */{i} * * *"),
        "daily" => format!("{m} {h} */{i} * *"),
        "weekly" => {
            let wd = rule.weekdays.clone().unwrap_or_else(|| vec![1]);
            let s = wd.iter().map(|w| w.to_string()).collect::<Vec<_>>().join(",");
            format!("{m} {h} * * {s}")
        }
        "monthly" => {
            let md = rule.month_days.clone().unwrap_or_else(|| vec![1]);
            let s = md.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(",");
            format!("{m} {h} {s} * *")
        }
        _ => "* * * * *".into(),
    }
}

/// 由 scheduleRule 计算 after_ms 之后的下一次运行时间（本地时区，毫秒）。
/// 各单位均为「从 after 起按锚点对齐向后扫描」，扫描上限防御死循环。
pub fn compute_next_run(rule: &ScheduleRule, after_ms: i64) -> Result<i64, String> {
    let interval = rule.interval.max(1);
    let hour = rule.hour.clamp(0, 23);
    let minute = rule.minute.clamp(0, 59);
    let after = Local
        .timestamp_millis_opt(after_ms)
        .single()
        .ok_or_else(|| "invalid after timestamp".to_string())?;
    let at_time = |day: chrono::NaiveDate| -> Option<i64> {
        Local
            .from_local_datetime(&day.and_hms_opt(hour as u32, minute as u32, 0)?)
            .single()
            .map(|t| t.timestamp_millis())
    };

    match rule.unit.as_str() {
        "minute" => {
            let start_minute = after_ms.div_euclid(60_000);
            for m in (start_minute + 1)..=(start_minute + interval + 2) {
                if m.rem_euclid(interval) == 0 {
                    return Ok(m * 60_000);
                }
            }
            Err("no next minute run".into())
        }
        "hourly" => {
            let start_hour = after.timestamp().div_euclid(3600);
            for h in (start_hour + 1)..=(start_hour + interval + 2) {
                if h.rem_euclid(interval) != 0 {
                    continue;
                }
                let ms = h * 3_600_000 + minute * 60_000;
                if ms > after_ms {
                    return Ok(ms);
                }
            }
            Err("no next hourly run".into())
        }
        "daily" => {
            let start_day = after.date_naive();
            for k in 0..=(interval * 2 + 5) {
                if (start_day + ChronoDuration::days(k)).num_days_from_ce() as i64
                    % interval
                    != 0
                {
                    continue;
                }
                if let Some(ms) = at_time(start_day + ChronoDuration::days(k)) {
                    if ms > after_ms {
                        return Ok(ms);
                    }
                }
            }
            Err("no next daily run".into())
        }
        "weekly" => {
            let weekdays = rule.weekdays.clone().unwrap_or_else(|| vec![1]);
            let start_day = after.date_naive();
            for k in 0..=(7 * interval + 8) {
                let day = start_day + ChronoDuration::days(k);
                let dow = day.weekday().num_days_from_sunday() as i64;
                if !weekdays.contains(&dow) {
                    continue;
                }
                if (day.num_days_from_ce() as i64).div_euclid(7) % interval != 0 {
                    continue;
                }
                if let Some(ms) = at_time(day) {
                    if ms > after_ms {
                        return Ok(ms);
                    }
                }
            }
            Err("no next weekly run".into())
        }
        "monthly" => {
            let month_days = rule.month_days.clone().unwrap_or_else(|| vec![1]);
            let base_month = (after.year() as i64) * 12 + (after.month0() as i64);
            for step in 0..(12 * interval + 13) {
                let month_index = base_month + step;
                if month_index % interval != 0 {
                    continue;
                }
                let year = month_index.div_euclid(12) as i32;
                let month = month_index.rem_euclid(12) as u32 + 1;
                for &md in &month_days {
                    if !(1..=31).contains(&md) {
                        continue;
                    }
                    let Some(first) = chrono::NaiveDate::from_ymd_opt(year, month, 1) else {
                        continue;
                    };
                    let Some(day) = first.with_day(md as u32) else {
                        continue; // 月末越界（如 2 月 31 日）
                    };
                    if let Some(ms) = at_time(day) {
                        if ms > after_ms {
                            return Ok(ms);
                        }
                    }
                }
            }
            Err("no next monthly run".into())
        }
        other => Err(format!("unsupported schedule unit: {other}")),
    }
}

// ---------------------------------------------------------------------------
// 调度器（claim + 派发）
// ---------------------------------------------------------------------------

/// 应用启动时收敛上次中断的 running 运行（应用关闭导致无法回报）。
fn mark_stale_running_runs() -> Result<i64, String> {
    let conn = db_conn()?;
    let now = now_ms();
    let changed = conn
        .execute(
            "UPDATE automation_runs SET status = 'stopped', error = '应用重启，运行中断', updated_at = ?1
             WHERE status = 'running'",
            rusqlite::params![now],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed as i64)
}

/// 认领所有到期任务：写 run 行（running）+ 推进 next_run_at / run_count，
/// 返回派发负载列表（由调用方经事件发给前端）。
fn claim_due() -> Result<Vec<AutomationDuePayload>, String> {
    let now = now_ms();
    let conn = db_conn()?;
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT automation_id FROM automations
                 WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?1)",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([now], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };

    let mut payloads = Vec::new();
    for id in ids {
        let Some(automation) = get_automation(&conn, &id)? else {
            continue;
        };
        if !automation.enabled {
            continue;
        }
        // 下一次运行时间：从现在起计算；失败则退避 1 小时并记录错误
        let next = match compute_next_run(&automation.schedule_rule, now) {
            Ok(v) => Some(v),
            Err(e) => {
                conn.execute(
                    "UPDATE automations SET last_error = ?2, next_run_at = ?3, updated_at = ?2
                     WHERE automation_id = ?1",
                    rusqlite::params![id, format!("{e} (at {now})"), now + 3_600_000],
                )
                .map_err(|e| e.to_string())?;
                Some(now + 3_600_000)
            }
        }
        .unwrap_or(now + 3_600_000);

        let run_id = format!("{}:{}", id, now);
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, scheduled_at, trigger, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'schedule', 'running', ?3, ?3)",
            rusqlite::params![run_id, id, now],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE automations
             SET run_count = run_count + 1, last_run_at = ?2, next_run_at = ?3, updated_at = ?2
             WHERE automation_id = ?1",
            rusqlite::params![id, now, next],
        )
        .map_err(|e| e.to_string())?;

        payloads.push(AutomationDuePayload {
            run_id,
            automation_id: id,
            title: automation.title,
            prompt: automation.prompt,
            workspace_path: automation.workspace_path,
            model_provider: automation.model_provider,
            model_id: automation.model_id,
        });
    }
    Ok(payloads)
}

/// 调度线程：每 20s 轮询一次（对齐 ZCode POLL_INTERVAL_MS）。
pub fn start_scheduler(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        if let Err(e) = mark_stale_running_runs() {
            eprintln!("automation stale-run cleanup failed: {e}");
        }
        loop {
            std::thread::sleep(std::time::Duration::from_secs(20));
            match claim_due() {
                Ok(payloads) => {
                    for payload in payloads {
                        if let Err(e) = app.emit("automation-due", &payload) {
                            eprintln!("automation-due emit failed: {e}");
                        }
                    }
                }
                Err(e) => eprintln!("automation claim_due failed: {e}"),
            }
        }
    });
}

// ---------------------------------------------------------------------------
// IPC 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn automation_list() -> Result<Vec<Automation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {AUTOMATION_COLUMNS} FROM automations ORDER BY created_at DESC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], row_to_automation)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn automation_create(upsert: AutomationUpsert) -> Result<Automation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let now = now_ms();
        let cron = rule_to_cron_display(&upsert.schedule_rule);
        let next = compute_next_run(&upsert.schedule_rule, now).ok();
        let automation_id = format!("auto-{}-{}", now, std::process::id());
        let automation = Automation {
            automation_id,
            title: upsert.title,
            cron_expr: cron,
            schedule_rule: upsert.schedule_rule,
            prompt: upsert.prompt,
            model_provider: upsert.model_provider,
            model_id: upsert.model_id,
            workspace_path: upsert.workspace_path,
            enabled: upsert.enabled,
            lifecycle_status: if upsert.enabled { "active".into() } else { "paused".into() },
            run_count: 0,
            next_run_at: next,
            last_run_at: None,
            last_error: None,
            created_at: now,
            updated_at: now,
        };
        let conn = db_conn()?;
        insert_automation(&conn, &automation)?;
        Ok(automation)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn automation_update(
    automation_id: String,
    upsert: AutomationUpsert,
) -> Result<Automation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        let now = now_ms();
        let cron = rule_to_cron_display(&upsert.schedule_rule);
        let next = if upsert.enabled {
            compute_next_run(&upsert.schedule_rule, now).ok()
        } else {
            None
        };
        conn.execute(
            "UPDATE automations SET title=?2, cron_expr=?3, schedule_rule=?4, prompt=?5, \
             model_provider=?6, model_id=?7, workspace_path=?8, enabled=?9, lifecycle_status=?10, \
             next_run_at=?11, updated_at=?12 WHERE automation_id=?1",
            rusqlite::params![
                automation_id,
                upsert.title,
                cron,
                rule_to_json(&upsert.schedule_rule),
                upsert.prompt,
                upsert.model_provider,
                upsert.model_id,
                upsert.workspace_path,
                upsert.enabled as i64,
                if upsert.enabled { "active" } else { "paused" },
                next,
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
        get_automation(&conn, &automation_id)?
            .ok_or_else(|| "automation disappeared after update".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn automation_delete(automation_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        conn.execute(
            "DELETE FROM automation_runs WHERE automation_id = ?1",
            [&automation_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM automations WHERE automation_id = ?1",
            [&automation_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn automation_set_enabled(
    automation_id: String,
    enabled: bool,
) -> Result<Automation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        let now = now_ms();
        let next = if enabled {
            let automation = get_automation(&conn, &automation_id)?
                .ok_or_else(|| format!("automation {automation_id} not found"))?;
            compute_next_run(&automation.schedule_rule, now).ok()
        } else {
            None
        };
        conn.execute(
            "UPDATE automations SET enabled=?2, lifecycle_status=?3, next_run_at=?4, updated_at=?5
             WHERE automation_id=?1",
            rusqlite::params![
                automation_id,
                enabled as i64,
                if enabled { "active" } else { "paused" },
                next,
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
        get_automation(&conn, &automation_id)?
            .ok_or_else(|| "automation disappeared after toggle".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn automation_run_now(automation_id: String) -> Result<AutomationDuePayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        let now = now_ms();
        let automation = get_automation(&conn, &automation_id)?
            .ok_or_else(|| format!("automation {automation_id} not found"))?;
        let run_id = format!("{}:manual:{:x}", automation_id, now);
        conn.execute(
            "INSERT INTO automation_runs (run_id, automation_id, trigger, status, created_at, updated_at)
             VALUES (?1, ?2, 'manual', 'running', ?3, ?3)",
            rusqlite::params![run_id, automation_id, now],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE automations SET run_count = run_count + 1, last_run_at = ?2, updated_at = ?2
             WHERE automation_id = ?1",
            rusqlite::params![automation_id, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(AutomationDuePayload {
            run_id,
            automation_id,
            title: automation.title,
            prompt: automation.prompt,
            workspace_path: automation.workspace_path,
            model_provider: automation.model_provider,
            model_id: automation.model_id,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn automation_list_runs(
    automation_id: String,
    limit: Option<i64>,
) -> Result<Vec<AutomationRun>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        let limit = limit.unwrap_or(50).clamp(1, 500);
        let mut stmt = conn
            .prepare(
                "SELECT run_id, automation_id, scheduled_at, trigger, status, task_id, error, created_at, updated_at
                 FROM automation_runs WHERE automation_id = ?1
                 ORDER BY created_at DESC LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![automation_id, limit], |row| {
                Ok(AutomationRun {
                    run_id: row.get("run_id")?,
                    automation_id: row.get("automation_id")?,
                    scheduled_at: row.get("scheduled_at")?,
                    trigger: row.get("trigger")?,
                    status: row.get("status")?,
                    task_id: row.get("task_id")?,
                    error: row.get("error")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 前端回报运行结束（outcome: succeeded | failed | stopped）。
#[tauri::command]
pub async fn automation_run_finished(
    run_id: String,
    status: String,
    task_id: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_conn()?;
        let now = now_ms();
        conn.execute(
            "UPDATE automation_runs SET status=?2, task_id=?3, error=?4, updated_at=?5 WHERE run_id=?1",
            rusqlite::params![run_id, status, task_id, error, now],
        )
        .map_err(|e| e.to_string())?;
        if let Some(err_text) = error {
            let _ = conn.execute(
                "UPDATE automations SET last_error=?2, updated_at=?3
                 WHERE automation_id = (SELECT automation_id FROM automation_runs WHERE run_id=?1)",
                rusqlite::params![run_id, err_text, now],
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// 单测（调度计算纯函数）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    fn rule(unit: &str, interval: i64, hour: i64, minute: i64) -> ScheduleRule {
        ScheduleRule { unit: unit.into(), interval, hour, minute, weekdays: None, month_days: None }
    }

    #[test]
    fn next_run_minute_steps_forward() {
        let now = now_ms();
        let next = compute_next_run(&rule("minute", 15, 0, 0), now).unwrap();
        assert!(next > now && (next - now) <= 15 * 60_000);
    }

    #[test]
    fn next_run_daily_advances_at_set_time() {
        // 用固定锚点：今天 09:00 之后的下一次 09:00 = 明天或后天（视当前时刻而定）
        let now = now_ms();
        let next = compute_next_run(&rule("daily", 1, 9, 0), now).unwrap();
        assert!(next > now);
        let dt = Local.timestamp_millis_opt(next).single().unwrap();
        assert_eq!((dt.hour(), dt.minute()), (9, 0));
    }

    #[test]
    fn next_run_weekday_skips_weekend() {
        // 工作日 09:00：连续扫描一定落在周一到周五
        let now = now_ms();
        let mut r = rule("weekly", 1, 9, 0);
        r.weekdays = Some(vec![1, 2, 3, 4, 5]);
        let next = compute_next_run(&r, now).unwrap();
        let dt = Local.timestamp_millis_opt(next).single().unwrap();
        // weekdays 采用 num_days_from_sunday 约定（0=周日…1=周一…5=周五）
        assert!((1..=5).contains(&dt.weekday().num_days_from_sunday()));
    }

    #[test]
    fn cron_display_matches_rule() {
        let mut r = rule("weekly", 1, 9, 30);
        r.weekdays = Some(vec![1, 2, 3, 4, 5]);
        assert_eq!(rule_to_cron_display(&r), "30 9 * * 1,2,3,4,5");
    }
}
