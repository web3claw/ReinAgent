//! notifications 单测：同键合并（计数/回未读/正文刷新）、归档、未读计数。
//! 运行：cargo test --lib notifications_tests

use crate::notifications::*;
use rusqlite::Connection;

fn setup_db() -> Connection {
    let conn = Connection::open_in_memory().expect("db");
    conn.execute_batch(NOTIFICATIONS_SCHEMA_DDL).expect("schema");
    conn
}

fn push_args(key: &str, title: &str, body: &str) -> NotifyPushArgs {
    NotifyPushArgs {
        category_key: key.into(),
        kind: "kanban".into(),
        title: title.into(),
        body: body.into(),
        link_view: Some("kanban".into()),
        link_task_id: Some("task-1".into()),
    }
}

#[test]
fn same_key_push_merges_and_bumps_count() {
    let conn = setup_db();
    assert_eq!(notify_push_conn(&conn, &push_args("kanban:c1", "卡片一", "执行失败 v1")).unwrap(), 1);
    // 同键第二次：正文刷新、计数+1、保持未读
    assert_eq!(notify_push_conn(&conn, &push_args("kanban:c1", "卡片一", "执行失败 v2")).unwrap(), 1);
    let rows = notify_list_conn(&conn, 50).unwrap();
    assert_eq!(rows.len(), 1, "同键必须合并为一行");
    assert_eq!(rows[0].count, 2);
    assert_eq!(rows[0].body, "执行失败 v2");
    assert!(rows[0].unread);
    // 不同键：新行，未读数 2
    assert_eq!(notify_push_conn(&conn, &push_args("kanban:c2", "卡片二", "等待回答")).unwrap(), 2);
}

#[test]
fn archive_removes_row_and_recounts() {
    let conn = setup_db();
    notify_push_conn(&conn, &push_args("kanban:c1", "a", "b")).unwrap();
    notify_push_conn(&conn, &push_args("kanban:c2", "a", "b")).unwrap();
    assert_eq!(notify_archive_conn(&conn, "kanban:c1").unwrap(), 1);
    let rows = notify_list_conn(&conn, 50).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].category_key, "kanban:c2");
    assert_eq!(notify_archive_all_conn(&conn).unwrap(), 0);
    assert_eq!(notify_list_conn(&conn, 50).unwrap().len(), 0);
    assert_eq!(notify_unread_count_conn(&conn).unwrap(), 0);
}

#[test]
fn empty_key_or_title_rejected() {
    let conn = setup_db();
    assert!(notify_push_conn(&conn, &push_args("  ", "t", "b")).is_err());
    assert!(notify_push_conn(&conn, &push_args("k", "  ", "b")).is_err());
}
