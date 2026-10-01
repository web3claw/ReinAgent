//! usage_stats 单测：回填幂等 / ZCode 快照形状（summary streak/peak/heatmap/日分模型/模型 share）。
//! 运行：cargo test --lib usage_stats

use crate::usage_stats::{usage_backfill_conn, usage_query_conn, MODEL_USAGE_SCHEMA};
use rusqlite::Connection;

fn setup_db() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory db");
    conn.execute_batch(MODEL_USAGE_SCHEMA).unwrap();
    conn.execute_batch(
        "CREATE TABLE message (
            task_id TEXT NOT NULL, msg_id TEXT NOT NULL, seq INTEGER NOT NULL,
            role TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER, ended_at INTEGER,
            tool_name TEXT, tool_call_id TEXT, is_error INTEGER, truncated_by TEXT,
            error TEXT, thinking_started_at INTEGER, thinking_duration_ms INTEGER,
            PRIMARY KEY (task_id, msg_id));
         CREATE TABLE part (
            task_id TEXT NOT NULL, msg_id TEXT NOT NULL, part_index INTEGER NOT NULL,
            kind TEXT NOT NULL, payload TEXT NOT NULL,
            PRIMARY KEY (task_id, msg_id, part_index));",
    )
    .unwrap();
    conn
}

fn insert_assistant_api_message(
    conn: &Connection,
    task_id: &str,
    msg_id: &str,
    started_at: i64,
    provider: &str,
    model_id: &str,
    usage_json: &str,
) {
    conn.execute(
        "INSERT INTO message (task_id, msg_id, seq, role, status, started_at, ended_at) VALUES (?1, ?2, 1, 'assistant', 'done', ?3, ?3)",
        rusqlite::params![task_id, msg_id, started_at],
    )
    .unwrap();
    let payload = format!(
        r#"{{"role":"assistant","provider":"{provider}","model":"{model_id}","usage":{usage_json}}}"#
    );
    conn.execute(
        "INSERT INTO part (task_id, msg_id, part_index, kind, payload) VALUES (?1, ?2, 0, 'api_message', ?3)",
        rusqlite::params![task_id, msg_id, payload],
    )
    .unwrap();
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[test]
fn backfill_extracts_usage_and_is_idempotent() {
    let mut conn = setup_db();
    // ⚠ 回填内含 30 天 prune：测试时间必须贴近 now
    let now = now_ms();
    insert_assistant_api_message(
        &conn, "t1", "m1", now, "deepseek", "deepseek-chat", r#"{"input":100,"output":20,"cacheRead":50,"cacheWrite":5}"#,
    );
    // 无 usage 的 assistant 行不产生事实
    insert_assistant_api_message(&conn, "t1", "m2", now, "deepseek", "deepseek-chat", "null");
    // agent 工具结果（subagent usage）
    conn.execute(
        "INSERT INTO message (task_id, msg_id, seq, role, status, started_at, tool_name) VALUES ('t1', 'm3', 2, 'tool', 'done', ?1, 'agent')",
        rusqlite::params![now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO part (task_id, msg_id, part_index, kind, payload) VALUES ('t1', 'm3', 0, 'tool_result',
         '{\"resultText\":\"x\",\"details\":{\"kind\":\"subagent\",\"subagentType\":\"explorer\",\"provider\":\"deepseek\",\"model\":\"deepseek-reasoner\",\"usage\":{\"input\":10,\"output\":4,\"cacheRead\":0,\"cacheWrite\":0}}}')",
        [],
    )
    .unwrap();

    let inserted = usage_backfill_conn(&mut conn).unwrap();
    assert_eq!(inserted, 2, "assistant(1) + subagent(1)；无 usage 行不产生事实");
    let again = usage_backfill_conn(&mut conn).unwrap();
    assert_eq!(again, 0, "INSERT OR IGNORE 幂等");

    let (model, source, total): (String, String, i64) = conn
        .query_row(
            "SELECT model, query_source, total_tokens FROM model_usage WHERE msg_id = 'm1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(model, "deepseek-chat");
    assert_eq!(source, "main_turn");
    // 口径对齐 ZCode：total = input + output（cache 是 breakdown 不叠加）
    assert_eq!(total, 120);

    let (model, source, provider): (String, String, String) = conn
        .query_row(
            "SELECT model, query_source, provider FROM model_usage WHERE msg_id = 'm3'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    // 用量按真实模型记账（2026-10-01）：details.provider/model，而非子代理类型名
    assert_eq!(model, "deepseek-reasoner");
    assert_eq!(provider, "deepseek");
    assert_eq!(source, "subagent");
}

#[test]
fn snapshot_shape_matches_zcode_contract() {
    let mut conn = setup_db();
    let now = now_ms();
    // 今天两个模型 + 3 天前一个模型（同任务跨天 → 会话时长/多日桶）
    insert_assistant_api_message(&conn, "t1", "m1", now, "p", "model-a", r#"{"input":100,"output":10,"cacheRead":50,"cacheWrite":0}"#);
    insert_assistant_api_message(&conn, "t1", "m2", now + 60_000, "p", "model-b", r#"{"input":200,"output":20,"cacheRead":0,"cacheWrite":0}"#);
    insert_assistant_api_message(&conn, "t1", "m3", now - 3 * 86_400_000, "p", "model-a", r#"{"input":1000,"output":100,"cacheRead":0,"cacheWrite":0}"#);
    usage_backfill_conn(&mut conn).unwrap();

    let snap = usage_query_conn(&conn, "all", "UTC", 0).unwrap();
    assert_eq!(snap.range, "all");
    assert_eq!(snap.source, "agent-db");
    assert_eq!(snap.summary.total_tokens, 1430);
    assert_eq!(snap.summary.active_days, 2);
    assert_eq!(snap.summary.peak_day_tokens, 1100);
    assert_eq!(snap.summary.current_streak_days, 1, "今天有用量");
    assert_eq!(snap.summary.longest_streak_days, 1, "两天相隔 3 天不连续");
    assert!(snap.summary.cache_hit_rate > 0.0);
    // favorite = 最高 tokens 模型
    let fav = snap.summary.favorite_model.as_ref().unwrap();
    assert_eq!(fav.model_id.as_deref(), Some("model-a"));

    // 模型分布 share（1210+220=1430）
    assert_eq!(snap.models.len(), 2);
    assert_eq!(snap.models[0].model_id.as_deref(), Some("model-a"));
    assert!((snap.models[0].share - 1210.0 / 1430.0).abs() < 1e-9);

    // 热力图：有周、max 一致、今天的格子 level>=1
    assert!(!snap.heatmap.weeks.is_empty());
    assert_eq!(snap.heatmap.max_tokens, 1100);
    let today_cell = snap
        .heatmap
        .weeks
        .iter()
        .flat_map(|w| w.days.iter())
        .find_map(|c| c.as_ref().filter(|c| c.total_tokens == 330))
        .expect("今天的格子应存在");
    assert!(today_cell.level >= 1);

    // 每日分模型：连续每日序列（对齐 ZCode）——今天起往前补齐到最早数据日（4 天）
    assert_eq!(snap.daily_model_usage.len(), 4, "7 天窗口从今天回补到最早数据日");
    let today = snap
        .daily_model_usage
        .iter()
        .find(|d| d.models.len() == 2)
        .expect("今天应有两个模型");
    assert!(
        today.models.iter().any(|m| m.model_id.as_deref() == Some("model-b")),
        "今天应含 model-b"
    );
}

#[test]
fn query_range_filters_by_since() {
    let mut conn = setup_db();
    let now = now_ms();
    insert_assistant_api_message(&conn, "t1", "new1", now, "p", "m", r#"{"input":10,"output":1,"cacheRead":0,"cacheWrite":0}"#);
    insert_assistant_api_message(&conn, "t1", "old1", now - 8 * 24 * 3600 * 1000, "p", "m", r#"{"input":999,"output":99,"cacheRead":0,"cacheWrite":0}"#);
    usage_backfill_conn(&mut conn).unwrap();

    let week = usage_query_conn(&conn, "7d", "UTC", 0).unwrap();
    assert_eq!(week.models[0].request_count, 1, "7d 只含新行");
    assert_eq!(week.daily_model_usage.len(), 7, "7d 补齐连续 7 天每日序列（含 0 数据天）");
    let all = usage_query_conn(&conn, "all", "UTC", 0).unwrap();
    assert_eq!(all.models[0].request_count, 2);
}

#[test]
fn reset_watermark_prevents_reimport_of_old_facts() {
    let mut conn = setup_db();
    // 测试 schema 无 kv 表：补一个（真实库由 conversation_store 迁移创建）
    conn.execute_batch("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .unwrap();
    let now = now_ms();
    insert_assistant_api_message(
        &conn, "t1", "m1", now, "deepseek", "deepseek-chat",
        r#"{"input":100,"output":20,"cacheRead":0,"cacheWrite":0}"#,
    );
    assert_eq!(usage_backfill_conn(&mut conn).unwrap(), 1);

    // 清零：账目表空 + 水位线=now
    let watermark: i64 = {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        conn.execute("DELETE FROM model_usage", []).unwrap();
        conn.execute(
            "INSERT INTO kv (key, value) VALUES ('usage-reset-watermark-ms', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![now.to_string()],
        )
        .unwrap();
        now
    };
    // 水位线之前的旧 part 不重灌
    assert_eq!(usage_backfill_conn(&mut conn).unwrap(), 0);
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM model_usage", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "清零后旧事实不重灌");

    // message 表直算指标同样受水位线约束：最长聊天时长/工具调用归零
    let snap = usage_query_conn(&conn, "all", "UTC", 0).unwrap();
    assert_eq!(snap.summary.longest_session_ms, 0, "清零后旧会话时长不计");
    assert_eq!(snap.summary.tool_call_count, 0, "清零后旧工具调用不计");

    // 水位线之后的新事实正常入账
    insert_assistant_api_message(
        &conn, "t1", "m2", watermark + 1_000, "deepseek", "deepseek-chat",
        r#"{"input":7,"output":3,"cacheRead":0,"cacheWrite":0}"#,
    );
    conn.execute(
        "INSERT INTO message (task_id, msg_id, seq, role, status, started_at, ended_at) VALUES ('t1', 'm3', 2, 'tool', 'done', ?1, ?1)",
        rusqlite::params![watermark + 2_000],
    )
    .unwrap();
    assert_eq!(usage_backfill_conn(&mut conn).unwrap(), 1);
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM model_usage", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1, "只有新事实入账");
    let snap = usage_query_conn(&conn, "all", "UTC", 0).unwrap();
    assert_eq!(snap.summary.tool_call_count, 1, "新工具调用入账");
}
