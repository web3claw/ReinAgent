//! 用量统计（P1-7，对齐 ZCode usage-observability 的本地事实表 + SQL 聚合思路）。
//!
//! 数据源：既有 `part` 表——`api_message`（assistant 原件，含 provider/modelId/usage）
//! 与 `tool_result`（agent 工具的 details.usage，query_source=subagent）。
//! **零写入链路改动**：`usage_backfill` 幂等扫描（INSERT OR IGNORE），打开面板时
//! 先回填再查询，数据即时最新；`usage_query` 在 SQL 层聚合（tz 偏移日桶）。
//! 无 cost 维度（对齐 ZCode：口径一律 token/请求数）。30 天滚动保留（prune）。

use serde::{Deserialize, Serialize};

/// model_usage 事实表（ZCode migration 0010 精简版）。
pub(crate) const MODEL_USAGE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS model_usage (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL,
    msg_id        TEXT NOT NULL,
    query_source  TEXT NOT NULL,
    provider      TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'completed',
    started_at    INTEGER NOT NULL,
    duration_ms   INTEGER,
    input_tokens      INTEGER NOT NULL DEFAULT 0,
    output_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_model_usage_started ON model_usage(started_at);
CREATE INDEX IF NOT EXISTS idx_model_usage_model ON model_usage(started_at, model);
";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageFavoriteModel {
    pub model_id: Option<String>,
    pub total_tokens: i64,
    pub share: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_hit_rate: f64,
    pub total_sessions: i64,
    pub total_turns: i64,
    pub tool_call_count: i64,
    pub tool_error_rate: f64,
    pub model_error_rate: f64,
    pub avg_time_to_first_token_ms: Option<i64>,
    pub avg_turn_duration_ms: Option<i64>,
    pub active_days: i64,
    pub current_streak_days: i64,
    pub longest_session_ms: i64,
    pub longest_streak_days: i64,
    pub peak_day_tokens: i64,
    pub favorite_model: Option<UsageFavoriteModel>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHeatmapCell {
    /// YYYY-MM-DD（UTC 日，对齐 ZCode dateKey）
    pub date: String,
    pub level: i32,
    pub total_tokens: i64,
    pub turn_count: i64,
    pub tool_call_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHeatmapWeek {
    pub week_index: i64,
    pub days: Vec<Option<UsageHeatmapCell>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHeatmap {
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub max_tokens: i64,
    pub weeks: Vec<UsageHeatmapWeek>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDailyModelItem {
    pub model_id: Option<String>,
    pub total_tokens: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDailyModelDay {
    pub date: String,
    pub models: Vec<UsageDailyModelItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelRow {
    pub model_id: Option<String>,
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub request_count: i64,
    pub share: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageToolRow {
    pub tool_name: String,
    pub call_count: i64,
    pub error_count: i64,
    pub error_rate: f64,
    pub avg_duration_ms: Option<i64>,
}

/// ZCode AppUsageSnapshot 同形快照（usage-stats.ts 契约）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub range: String,
    pub generated_at: i64,
    pub time_zone: String,
    pub source: String,
    pub summary: UsageSummary,
    pub heatmap: UsageHeatmap,
    pub daily_model_usage: Vec<UsageDailyModelDay>,
    pub models: Vec<UsageModelRow>,
    pub tools: Vec<UsageToolRow>,
}

fn parse_usage_field(value: &serde_json::Value, key: &str) -> i64 {
    value.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

/// 幂等回填：扫 part 表的 api_message（assistant）与 agent 工具的 tool_result，
/// 解析出 usage 行 INSERT OR IGNORE。返回新写入行数。（接受连接参数以便测试。）
pub(crate) fn usage_backfill_sync() -> Result<i64, String> {
    let mut conn = crate::conversation_store::db_conn()?;
    usage_backfill_conn(&mut conn)
}

pub(crate) fn usage_backfill_conn(conn: &mut rusqlite::Connection) -> Result<i64, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("txn failed: {e}"))?;
    let mut inserted: i64 = 0;

    // 1) assistant api_message：provider/modelId/usage + message.started_at
    let mut stmt = tx
        .prepare(
            "SELECT p.task_id, p.msg_id, m.started_at, p.payload
             FROM part p JOIN message m ON m.task_id = p.task_id AND m.msg_id = p.msg_id
             WHERE p.kind = 'api_message' AND m.role = 'assistant'",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, Option<i64>, String)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    for (task_id, msg_id, started_at, payload) in rows {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&payload) else {
            continue;
        };
        let usage = match v.get("usage") {
            Some(u) if u.is_object() => u,
            _ => continue, // 无 usage 的 assistant 行不产生用量事实
        };
        let input = parse_usage_field(usage, "input");
        let output = parse_usage_field(usage, "output");
        let cache_read = parse_usage_field(usage, "cacheRead");
        let cache_write = parse_usage_field(usage, "cacheWrite");
        let provider = v
            .get("provider")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        // pi-ai AssistantMessage 的模型名在 `model` 字段（实测；modelId 不存在）
        let model = ["model", "modelId", "modelName"]
            .iter()
            .find_map(|k| v.get(k).and_then(|x| x.as_str()))
            .unwrap_or("")
            .to_string();
        let id = format!("{task_id}:{msg_id}");
        let started = started_at.unwrap_or(0);
        let n = tx
            .execute(
                "INSERT OR IGNORE INTO model_usage
                 (id, task_id, msg_id, query_source, provider, model, status, started_at,
                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens)
                 VALUES (?1, ?2, ?3, 'main_turn', ?4, ?5, 'completed', ?6, ?7, ?8, ?9, ?10, ?11)",
                rusqlite::params![
                    id,
                    task_id,
                    msg_id,
                    provider,
                    model,
                    started,
                    input,
                    output,
                    cache_read,
                    cache_write,
                    input + output
                ],
            )
            .map_err(|e| e.to_string())?;
        inserted += n as i64;
        // 纠正历史空名行（早期字段名解析不到时留下的 model=''）
        if !model.is_empty() {
            tx.execute(
                "UPDATE model_usage SET provider = ?2, model = ?3 WHERE id = ?1 AND model = ''",
                rusqlite::params![id, provider, model],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // 2) agent 工具结果：details.usage（query_source=subagent，model=子代理类型）
    let mut stmt = tx
        .prepare(
            "SELECT p.task_id, p.msg_id, m.started_at, p.payload
             FROM part p JOIN message m ON m.task_id = p.task_id AND m.msg_id = p.msg_id
             WHERE p.kind = 'tool_result' AND m.tool_name = 'agent'",
        )
        .map_err(|e| e.to_string())?;
    let agent_rows: Vec<(String, String, Option<i64>, String)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    for (task_id, msg_id, started_at, payload) in agent_rows {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&payload) else {
            continue;
        };
        let Some(details) = v.get("details").filter(|d| d.is_object()) else {
            continue;
        };
        let Some(usage) = details.get("usage").filter(|u| u.is_object()) else {
            continue;
        };
        // tool_result part 的 payload 形如 {resultText, details}——details.usage 才有数；
        // 若顶层 details 缺失则尝试 payload.details（已覆盖）。usage 为全 0 也如实入表
        // （is_error 的运行 usage 为零是真事实），但 details.kind 不是 subagent 的跳过。
        if details.get("kind").and_then(|k| k.as_str()) != Some("subagent") {
            continue;
        }
        let input = parse_usage_field(usage, "input");
        let output = parse_usage_field(usage, "output");
        let cache_read = parse_usage_field(usage, "cacheRead");
        let cache_write = parse_usage_field(usage, "cacheWrite");
        let model = details
            .get("subagentType")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string();
        let id = format!("{task_id}:{msg_id}:sub");
        let started = started_at.unwrap_or(0);
        let n = tx
            .execute(
                "INSERT OR IGNORE INTO model_usage
                 (id, task_id, msg_id, query_source, provider, model, status, started_at,
                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens)
                 VALUES (?1, ?2, ?3, 'subagent', 'subagent', ?4, 'completed', ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    id,
                    task_id,
                    msg_id,
                    model,
                    started,
                    input,
                    output,
                    cache_read,
                    cache_write,
                    input + output
                ],
            )
            .map_err(|e| e.to_string())?;
        inserted += n as i64;
    }

    // 3) 30 天滚动保留（对齐 ZCode USAGE_RETENTION_DAYS）
    let cutoff = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64 - 30 * 24 * 3600 * 1000)
        .unwrap_or(0);
    tx.execute(
        "DELETE FROM model_usage WHERE started_at < ?1",
        rusqlite::params![cutoff],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| format!("commit failed: {e}"))?;
    Ok(inserted)
}

pub(crate) fn usage_query_sync(
    range: &str,
    time_zone: &str,
    tz_offset_ms: i64,
) -> Result<UsageSnapshot, String> {
    let conn = crate::conversation_store::db_conn()?;
    usage_query_conn(&conn, range, time_zone, tz_offset_ms)
}

fn utc_date_from_day_index(day_index: i64) -> String {
    // dayIndex（含 tz 偏移的本地日序）→ UTC 日期字符串（civil-from-days，Howard Hinnant 算法）
    let days = day_index;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Unix epoch day → UTC 星期几（0=周日）。1970-01-01 是周四。
fn utc_weekday(day_index: i64) -> i64 {
    (day_index + 4).rem_euclid(7)
}

/// 热力图 level（对齐 ZCode usage-stats-builder：>75%→4 / >50%→3 / >25%→2 / else 1）。
fn heatmap_level(value: i64, max: i64) -> i32 {
    if value <= 0 || max <= 0 {
        return 0;
    }
    let ratio = value as f64 / max as f64;
    if ratio > 0.75 {
        4
    } else if ratio > 0.5 {
        3
    } else if ratio > 0.25 {
        2
    } else {
        1
    }
}

pub(crate) fn usage_query_conn(
    conn: &rusqlite::Connection,
    range: &str,
    time_zone: &str,
    tz_offset_ms: i64,
) -> Result<UsageSnapshot, String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let today_index = (now_ms + tz_offset_ms).div_euclid(86_400_000);
    let since = match range {
        "7d" => now_ms - 7 * 24 * 3600 * 1000,
        "30d" => now_ms - 30 * 24 * 3600 * 1000,
        _ => 0,
    };

    // ---- summary（对齐 ZCode appUsageSummarySchema；turn≈模型请求行、tool 从 message 表）----
    let (total_tokens, input_tokens, output_tokens, cache_read, cache_write, total_turns, total_sessions): (
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = conn
        .query_row(
            "SELECT COALESCE(SUM(total_tokens),0), COALESCE(SUM(input_tokens),0),
                    COALESCE(SUM(output_tokens),0), COALESCE(SUM(cache_read_tokens),0),
                    COALESCE(SUM(cache_write_tokens),0), COUNT(*),
                    COUNT(DISTINCT task_id)
             FROM model_usage",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    let tool_call_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM message WHERE role = 'tool'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let tool_error_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM message WHERE role = 'tool' AND is_error = 1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let longest_session_ms: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(span), 0) FROM (
                SELECT MAX(ended_at) - MIN(started_at) AS span FROM message
                WHERE started_at IS NOT NULL AND ended_at IS NOT NULL
                GROUP BY task_id
             )",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    // ---- 每日聚合（tokens + 请求数）——热力图 / streak / peak 的共同底料 ----
    let mut day_stmt = conn
        .prepare(
            "SELECT CAST((started_at + ?1) / 86400000 AS INTEGER) AS day_index,
                    SUM(total_tokens), COUNT(*)
             FROM model_usage GROUP BY day_index ORDER BY day_index",
        )
        .map_err(|e| e.to_string())?;
    let day_rows: Vec<(i64, i64, i64)> = day_stmt
        .query_map(rusqlite::params![tz_offset_ms], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(day_stmt);

    // ---- 工具每日计数（heatmap 的 toolCallCount）----
    let mut tool_day_stmt = conn
        .prepare(
            "SELECT CAST((started_at + ?1) / 86400000 AS INTEGER) AS day_index, COUNT(*)
             FROM message WHERE role = 'tool' AND started_at IS NOT NULL
             GROUP BY day_index",
        )
        .map_err(|e| e.to_string())?;
    let tool_day_rows: std::collections::HashMap<i64, i64> = tool_day_stmt
        .query_map(rusqlite::params![tz_offset_ms], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<(i64, i64)>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    drop(tool_day_stmt);

    let max_day_tokens = day_rows.iter().map(|(_, t, _)| *t).max().unwrap_or(0);
    let active_days = day_rows.len() as i64;

    // streak：以「今天」为锚往回数连续有用量天；全序最长连续段
    let days_with_usage: std::collections::HashSet<i64> =
        day_rows.iter().filter(|(_, t, _)| *t > 0).map(|(d, _, _)| *d).collect();
    let mut current_streak = 0i64;
    let mut cursor = today_index;
    while days_with_usage.contains(&cursor) {
        current_streak += 1;
        cursor -= 1;
    }
    let mut longest_streak = 0i64;
    let mut run = 0i64;
    let mut sorted_days: Vec<i64> = days_with_usage.iter().copied().collect();
    sorted_days.sort_unstable();
    for (i, day) in sorted_days.iter().enumerate() {
        run = if i > 0 && *day == sorted_days[i - 1] + 1 { run + 1 } else { 1 };
        longest_streak = longest_streak.max(run);
    }

    let favorite = conn
        .query_row(
            "SELECT model, SUM(total_tokens) FROM model_usage
             WHERE model != '' GROUP BY model ORDER BY SUM(total_tokens) DESC LIMIT 1",
            [],
            |r| {
                Ok(UsageFavoriteModel {
                    model_id: Some(r.get::<_, String>(0)?),
                    total_tokens: r.get(1)?,
                    share: 0.0,
                })
            },
        )
        .ok();
    let favorite = favorite.map(|mut f| {
        f.share = if total_tokens > 0 { f.total_tokens as f64 / total_tokens as f64 } else { 0.0 };
        f
    });

    let summary = UsageSummary {
        total_tokens,
        input_tokens,
        output_tokens,
        reasoning_tokens: 0,
        cache_creation_tokens: cache_write,
        cache_read_tokens: cache_read,
        cache_hit_rate: if input_tokens > 0 {
            cache_read as f64 / input_tokens as f64
        } else {
            0.0
        },
        total_sessions,
        total_turns,
        tool_call_count,
        tool_error_rate: if tool_call_count > 0 {
            tool_error_count as f64 / tool_call_count as f64
        } else {
            0.0
        },
        model_error_rate: 0.0,
        avg_time_to_first_token_ms: None,
        avg_turn_duration_ms: None,
        active_days,
        current_streak_days: current_streak,
        longest_session_ms,
        longest_streak_days: longest_streak,
        peak_day_tokens: max_day_tokens,
        favorite_model: favorite,
    };

    // ---- 热力图：按自然周（周日起）切周，未来天补 null（前端再补齐 52 周 0 格）----
    let heatmap_start_index = today_index - (52 * 7 - 1);
    let tokens_by_day: std::collections::HashMap<i64, (i64, i64)> =
        day_rows.iter().map(|(d, t, c)| (*d, (*t, *c))).collect();
    let mut weeks: Vec<UsageHeatmapWeek> = Vec::new();
    // 第一周起点对齐到周日（getUTCDay==0）
    let first_sunday = heatmap_start_index - utc_weekday(heatmap_start_index);
    let mut week_start = first_sunday;
    let mut week_index = 0i64;
    while week_start <= today_index {
        let mut days: Vec<Option<UsageHeatmapCell>> = Vec::with_capacity(7);
        for offset in 0..7 {
            let day_index = week_start + offset;
            if day_index > today_index {
                days.push(None);
                continue;
            }
            let (tokens, turns) = tokens_by_day.get(&day_index).copied().unwrap_or((0, 0));
            days.push(Some(UsageHeatmapCell {
                date: utc_date_from_day_index(day_index),
                level: heatmap_level(tokens, max_day_tokens),
                total_tokens: tokens,
                turn_count: turns,
                tool_call_count: tool_day_rows.get(&day_index).copied().unwrap_or(0),
            }));
        }
        weeks.push(UsageHeatmapWeek { week_index, days });
        week_index += 1;
        week_start += 7;
    }
    let heatmap = UsageHeatmap {
        start_date: weeks
            .first()
            .and_then(|w| w.days.first())
            .and_then(|c| c.as_ref())
            .map(|c| c.date.clone()),
        end_date: weeks
            .last()
            .and_then(|w| w.days.iter().rev().find_map(|c| c.as_ref()))
            .map(|c| c.date.clone()),
        max_tokens: max_day_tokens,
        weeks,
    };

    // ---- 范围内每日分模型（趋势图）----
    let mut daily_stmt = conn
        .prepare(
            "SELECT CAST((started_at + ?2) / 86400000 AS INTEGER) AS day_index, model,
                    SUM(total_tokens)
             FROM model_usage WHERE started_at >= ?1
             GROUP BY day_index, model ORDER BY day_index",
        )
        .map_err(|e| e.to_string())?;
    let daily_rows: Vec<(i64, String, i64)> = daily_stmt
        .query_map(rusqlite::params![since, tz_offset_ms], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(daily_stmt);

    let mut daily_map: std::collections::BTreeMap<i64, Vec<UsageDailyModelItem>> =
        std::collections::BTreeMap::new();
    for (day_index, model, tokens) in daily_rows {
        daily_map
            .entry(day_index)
            .or_default()
            .push(UsageDailyModelItem { model_id: Some(model), total_tokens: tokens });
    }
    // 补齐**连续每日序列**（对齐 ZCode：30d/7d 协议结果是每日一行，无数据天为空
    // models——否则趋势图只在有数据的天之间连线，「近 30 天」会缩成两三个点）。
    // all 范围从最早数据日起补；7d/30d 从范围起点补到今天。
    let daily_start_index = match range {
        "7d" => today_index - 6,
        "30d" => today_index - 29,
        _ => daily_map.keys().copied().min().unwrap_or(today_index),
    };
    let mut daily_model_usage: Vec<UsageDailyModelDay> = Vec::new();
    let mut cursor_day = daily_start_index;
    while cursor_day <= today_index {
        let models = daily_map.remove(&cursor_day).unwrap_or_default();
        daily_model_usage.push(UsageDailyModelDay {
            date: utc_date_from_day_index(cursor_day),
            models,
        });
        cursor_day += 1;
    }

    // ---- 范围内模型分布（含 share）----
    let mut models_stmt = conn
        .prepare(
            "SELECT model, SUM(total_tokens), SUM(input_tokens), SUM(output_tokens), COUNT(*)
             FROM model_usage WHERE started_at >= ?1
             GROUP BY model ORDER BY SUM(total_tokens) DESC",
        )
        .map_err(|e| e.to_string())?;
    let model_rows: Vec<(String, i64, i64, i64, i64)> = models_stmt
        .query_map(rusqlite::params![since], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(models_stmt);
    let range_model_total: i64 = model_rows.iter().map(|(_, t, ..)| *t).sum();
    let models: Vec<UsageModelRow> = model_rows
        .into_iter()
        .map(|(model, total, input, output, requests)| UsageModelRow {
            model_id: if model.is_empty() { None } else { Some(model) },
            total_tokens: total,
            input_tokens: input,
            output_tokens: output,
            request_count: requests,
            share: if range_model_total > 0 {
                total as f64 / range_model_total as f64
            } else {
                0.0
            },
        })
        .collect();

    Ok(UsageSnapshot {
        range: range.to_string(),
        generated_at: now_ms,
        time_zone: time_zone.to_string(),
        source: "agent-db".to_string(),
        summary,
        heatmap,
        daily_model_usage,
        models,
        tools: Vec::new(),
    })
}

/// 打开面板用：先回填再查询（一个命令往返）。
#[tauri::command]
pub async fn usage_snapshot(
    range: String,
    time_zone: String,
    tz_offset_ms: i64,
) -> Result<UsageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        usage_backfill_sync()?;
        usage_query_sync(&range, &time_zone, tz_offset_ms)
    })
    .await
    .map_err(|e| e.to_string())?
}