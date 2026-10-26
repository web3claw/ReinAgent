//! wiki 单测：schema/迁移、任务状态机与陈旧回收、页面写入唯一性、scan 投影、上下文采集。
//! 运行：cargo test --lib wiki_tests

use crate::knowledge_index::KNOWLEDGE_SCHEMA_DDL;
use crate::wiki::*;
use rusqlite::Connection;
use std::fs;

fn setup_db() -> Connection {
    let conn = Connection::open_in_memory().expect("db");
    conn.execute_batch(KNOWLEDGE_SCHEMA_DDL).expect("knowledge schema");
    migrate_knowledge_sources_v2(&conn).expect("migrate");
    conn.execute_batch(WIKI_SCHEMA_DDL).expect("wiki schema");
    conn
}

#[test]
fn migration_relaxes_source_type_check() {
    // 用 v1 旧 CHECK 建表（模拟已存在的旧库），数据先落两行
    let conn = Connection::open_in_memory().expect("db");
    conn.execute_batch(
        "CREATE TABLE knowledge_sources (
            source_id       TEXT PRIMARY KEY,
            source_type     TEXT    NOT NULL CHECK (source_type IN ('note', 'import')),
            title           TEXT    NOT NULL DEFAULT '',
            source_path     TEXT    NOT NULL DEFAULT '',
            fingerprint     TEXT    NOT NULL DEFAULT '',
            chunk_count     INTEGER NOT NULL DEFAULT 0,
            status          TEXT    NOT NULL CHECK (status IN ('ok', 'error')),
            error           TEXT,
            model_id        TEXT    NOT NULL DEFAULT '',
            dims            INTEGER,
            last_indexed_at INTEGER NOT NULL DEFAULT 0);
         INSERT INTO knowledge_sources (source_id, source_type, title, status, model_id, last_indexed_at)
         VALUES ('note:a', 'note', '旧笔记', 'ok', '', 7);",
    )
    .unwrap();
    // 旧库拒绝 wiki 类型
    assert!(conn.execute(
        "INSERT INTO knowledge_sources (source_id, source_type, title, status, model_id, last_indexed_at)
         VALUES ('wiki:x', 'wiki', 't', 'ok', '', 0)",
        [],
    ).is_err(), "迁移前 wiki 类型应被 CHECK 拒绝");
    // 迁移执行：数据保留 + wiki 放行 + 非法类型仍拒绝
    assert!(migrate_knowledge_sources_v2(&conn).unwrap());
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM knowledge_sources", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1, "旧数据必须保留");
    conn.execute(
        "INSERT INTO knowledge_sources (source_id, source_type, title, status, model_id, last_indexed_at)
         VALUES ('wiki:x', 'wiki', 't', 'ok', '', 0)",
        [],
    ).expect("迁移后 wiki 类型应被接受");
    assert!(conn.execute(
        "INSERT INTO knowledge_sources (source_id, source_type, title, status, model_id, last_indexed_at)
         VALUES ('wiki:y', 'bogus', 't', 'ok', '', 0)",
        [],
    ).is_err());
    // 幂等：再次迁移返回 false
    assert!(!migrate_knowledge_sources_v2(&conn).unwrap());
}

#[test]
fn job_lifecycle_and_stale_reaping() {
    let conn = setup_db();
    let job = wiki_job_create_conn(&conn, "/tmp/proj").unwrap();
    assert_eq!(job.status, 0);
    // 更新到运行态
    wiki_job_update_conn(&conn, WikiJobUpdateArgs {
        id: job.id.clone(), status: Some(1), stage: Some("采集中".into()),
        progress: Some(5), total_pages: None, done_pages: None, set_id: None, warning: None, error: None,
    }).unwrap();
    let running = wiki_job_get_conn(&conn, &job.id).unwrap().unwrap();
    assert_eq!(running.status, 1);
    assert_eq!(running.stage, "采集中");
    // 未超时：不回收
    assert_eq!(wiki_reap_stale_jobs_conn(&conn).unwrap(), 0);
    // 人为把 updated_at 拨回 11 分钟前 → 回收为失败
    conn.execute(
        "UPDATE wiki_jobs SET updated_at = updated_at - 660000 WHERE id = ?1",
        rusqlite::params![job.id],
    ).unwrap();
    assert_eq!(wiki_reap_stale_jobs_conn(&conn).unwrap(), 1);
    let stale = wiki_job_get_conn(&conn, &job.id).unwrap().unwrap();
    assert_eq!(stale.status, 3);
    assert!(stale.error.unwrap().contains("中断"));
    // list 触发回收，失败任务仍在列表
    assert_eq!(wiki_job_list_conn(&conn, 10).unwrap().len(), 1);
}

#[test]
fn page_write_upsert_and_scan_projection() {
    let conn = setup_db();
    let id = wiki_write_page_conn(&conn, WikiWritePageArgs {
        id: None, set_id: "set-1".into(), workspace: "/tmp/proj".into(), sort_order: 0,
        chapter: "".into(), title: "总览".into(), brief: "".into(), content: "# Wiki\n正文 v1".into(),
    }).unwrap();
    wiki_write_page_conn(&conn, WikiWritePageArgs {
        id: None, set_id: "set-1".into(), workspace: "/tmp/proj".into(), sort_order: 1,
        chapter: "第一章".into(), title: "架构".into(), brief: "b".into(), content: "c".into(),
    }).unwrap();
    // 同 sort_order 重写覆盖（单页重生成路径）
    wiki_write_page_conn(&conn, WikiWritePageArgs {
        id: None, set_id: "set-1".into(), workspace: "/tmp/proj".into(), sort_order: 1,
        chapter: "第一章".into(), title: "架构 v2".into(), brief: "b2".into(), content: "c2 长一些的内容".into(),
    }).unwrap();
    let docs = wiki_documents_by_set_conn(&conn, "set-1").unwrap();
    assert_eq!(docs.len(), 2);
    assert_eq!(docs[1].title, "架构 v2");

    let sets = wiki_sets_list_conn(&conn).unwrap();
    assert_eq!(sets.len(), 1);
    assert_eq!(sets[0].title, "总览");
    assert_eq!(sets[0].page_count, 2);

    // scan 投影：wiki 页 → source_type 'wiki' 源行
    let rows = wiki_scan_sources_conn(&conn).unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows[0].source_id.starts_with("wiki:"));
    assert_eq!(rows[0].source_type, "wiki");
    assert!(rows[0].fingerprint.contains(':'));
    let _ = id;
}

#[test]
fn collect_context_reads_readme_tree_and_sources() {
    let temp = std::env::temp_dir().join(format!("wiki-ctx-{}", std::process::id()));
    let _ = fs::remove_dir_all(&temp);
    fs::create_dir_all(temp.join("src")).unwrap();
    fs::create_dir_all(temp.join("node_modules/pkg")).unwrap();
    fs::write(temp.join("README.md"), "# Demo\n\n演示项目".to_string()).unwrap();
    fs::write(temp.join("src/main.rs"), "fn main() {}".to_string()).unwrap();
    fs::write(temp.join("src/lib.rs"), "pub mod x;".to_string()).unwrap();
    fs::write(temp.join("node_modules/pkg/index.js"), "junk".to_string()).unwrap();

    let m = wiki_collect_context_sync(temp.to_str().unwrap()).unwrap();
    assert!(m.failure.is_none());
    assert!(m.base_context.contains("# Demo"));
    // 忽略目录不进树
    assert!(!m.tree.contains("node_modules"));
    assert!(m.tree.contains("src/"));
    // 源码采样命中 .rs
    assert!(m.sources.contains("src/main.rs"));
    assert!(m.top_level_modules.iter().any(|x| x == "src"));

    // 不存在的工作区 → failure 如实
    let bad = wiki_collect_context_sync("/nonexistent-path-xyz").unwrap();
    assert!(bad.failure.is_some());
    let _ = fs::remove_dir_all(&temp);
}
