//! graph 单测：去重落库 / 别名归一 / 三元组唯一 / 合并 / 按源清理 / 检索 1 跳扩展。
//! 运行：cargo test --lib graph_tests

use crate::graph::*;
use crate::knowledge_index::KNOWLEDGE_SCHEMA_DDL;
use rusqlite::Connection;

fn setup_db() -> Connection {
    let conn = Connection::open_in_memory().expect("db");
    conn.execute_batch(KNOWLEDGE_SCHEMA_DDL).expect("knowledge schema");
    conn
}

fn entity(name: &str, t: &str) -> ExtractEntityInput {
    ExtractEntityInput { name: name.into(), r#type: t.into(), description: String::new() }
}

fn relation(source: &str, target: &str, rel: &str) -> ExtractRelationInput {
    ExtractRelationInput { source: source.into(), target: target.into(), relation: rel.into(), description: String::new() }
}

#[test]
fn extraction_dedupes_entities_case_insensitive_and_aliases() {
    let conn = setup_db();
    let r1 = graph_apply_extraction_conn(&conn, GraphApplyExtractionArgs {
        source_id: Some("src-1".into()),
        entities: vec![entity("ReinAgent", "Project"), entity("Tauri", "tech"), entity("Rust", "language")],
        relations: vec![relation("ReinAgent", "Tauri", "depends_on"), relation("ReinAgent", "Rust", "belongs_to")],
    }).unwrap();
    assert_eq!(r1.new_entities, 3);
    assert_eq!(r1.new_relations, 2);

    // 二次抽取：大小写不同的同名实体去重；org 别名归一后仍是新类型校验
    let r2 = graph_apply_extraction_conn(&conn, GraphApplyExtractionArgs {
        source_id: Some("src-2".into()),
        entities: vec![entity("reinagent", "concept"), entity("GitHub", "org")],
        relations: vec![relation("ReinAgent", "Tauri", "depends_on"), relation("ReinAgent", "GitHub", "related_to")],
    }).unwrap();
    assert_eq!(r2.new_entities, 1);
    assert_eq!(r2.skipped_entities, 1);
    // 三元组重复去重；新关系正常落库
    assert_eq!(r2.new_relations, 1);
    assert_eq!(r2.skipped_relations, 1);

    let data = graph_get_conn(&conn).unwrap();
    assert_eq!(data.entities.len(), 4);
    // tech → technology / org → organization 别名归一
    let types: Vec<(String, String)> = data.entities.iter().map(|e| (e.name.clone(), e.entity_type.clone())).collect();
    assert!(types.contains(&("Tauri".into(), "technology".into())));
    assert!(types.contains(&("GitHub".into(), "organization".into())));
    // 非法类型回落 concept
    assert!(types.contains(&("Rust".into(), "concept".into())));
    assert_eq!(data.relations.len(), 3);
}

#[test]
fn relation_with_unknown_entity_is_skipped() {
    let conn = setup_db();
    let r = graph_apply_extraction_conn(&conn, GraphApplyExtractionArgs {
        source_id: None,
        entities: vec![entity("A", "concept")],
        relations: vec![relation("A", "不存在的实体", "related_to")],
    }).unwrap();
    assert_eq!(r.new_entities, 1);
    assert_eq!(r.skipped_relations, 1);
    assert_eq!(graph_get_conn(&conn).unwrap().relations.len(), 0);
}

#[test]
fn delete_by_source_only_removes_that_source_relations() {
    let conn = setup_db();
    graph_apply_extraction_conn(&conn, GraphApplyExtractionArgs {
        source_id: Some("src-1".into()),
        entities: vec![entity("A", "concept"), entity("B", "concept")],
        relations: vec![relation("A", "B", "related_to")],
    }).unwrap();
    // belongs_to 是 LLM 常见偏差拼写 → 别名归一为 belong_to（与 related_to 不撞三元组）
    graph_apply_extraction_conn(&conn, GraphApplyExtractionArgs {
        source_id: Some("src-2".into()),
        entities: vec![entity("A", "concept")],
        relations: vec![relation("A", "B", "belongs_to")],
    }).unwrap();
    let removed = graph_delete_by_source_conn(&conn, "src-1").unwrap();
    assert_eq!(removed, 1);
    let data = graph_get_conn(&conn).unwrap();
    // src-2 的关系保留（belong_to）；实体不删（实体是全局的，只清关系）
    assert_eq!(data.relations.len(), 1);
    assert_eq!(data.relations[0].relation_type, "belong_to");
    assert_eq!(data.entities.len(), 2);
}

#[test]
fn merge_entities_rewires_and_cleans_loops_and_dupes() {
    let conn = setup_db();
    graph_apply_extraction_conn(&conn, GraphApplyExtractionArgs {
        source_id: None,
        entities: vec![entity("React", "technology"), entity("react.js", "technology"), entity("Vite", "technology")],
        relations: vec![
            relation("React", "Vite", "related_to"),
            relation("react.js", "Vite", "related_to"), // 合并后与上条重复
        ],
    }).unwrap();
    let data = graph_get_conn(&conn).unwrap();
    let react_id = data.entities.iter().find(|e| e.name == "React").unwrap().id.clone();
    let reactjs_id = data.entities.iter().find(|e| e.name == "react.js").unwrap().id.clone();

    graph_merge_entities_conn(&conn, GraphMergeArgs { keep_id: react_id.clone(), merge_id: reactjs_id.clone() }).unwrap();
    let after = graph_get_conn(&conn).unwrap();
    // react.js 被删；重复三元组去重后只剩 1 条
    assert_eq!(after.entities.len(), 2);
    assert!(after.entities.iter().all(|e| e.name != "react.js"));
    assert_eq!(after.relations.len(), 1);
}

#[test]
fn one_hop_expansion_appends_neighbor_sources_with_flag() {
    let conn = setup_db();
    // 知识源 + chunk（1 跳扩展 JOIN 用）
    for (sid, title) in [("s-note-1", "React 笔记"), ("s-note-2", "Vite 笔记"), ("s-note-3", "无关笔记")] {
        conn.execute(
            "INSERT INTO knowledge_sources (source_id, source_type, title, source_path, fingerprint, chunk_count, status, model_id, last_indexed_at)
             VALUES (?1, 'note', ?2, '', '', 1, 'ok', 'm', 0)",
            rusqlite::params![sid, title],
        ).unwrap();
        conn.execute(
            "INSERT INTO knowledge_chunks (source_id, chunk_index, heading_path, content, embedding, dims)
             VALUES (?1, 0, '', ?2, X'00000000', 1)",
            rusqlite::params![sid, format!("{title} 正文")],
        ).unwrap();
    }
    // React(Vite 关联) 实体：s-note-1 关联 React；s-note-2 也关联 React
    graph_apply_extraction_conn(&conn, GraphApplyExtractionArgs {
        source_id: Some("s-note-1".into()),
        entities: vec![entity("React", "technology"), entity("前端", "concept")],
        relations: vec![relation("React", "前端", "belongs_to")],
    }).unwrap();
    graph_apply_extraction_conn(&conn, GraphApplyExtractionArgs {
        source_id: Some("s-note-2".into()),
        entities: vec![entity("React", "technology"), entity("Webpack", "technology")],
        relations: vec![relation("React", "Webpack", "compared_with")],
    }).unwrap();

    let hits = vec![crate::knowledge_index::KnowledgeSearchHit {
        source_id: "s-note-1".into(), source_type: "note".into(), title: "React 笔记".into(),
        source_path: String::new(), chunk_index: 0, heading_path: String::new(),
        content: "命中块".into(), score: 0.9, from_graph: false,
    }];
    let expanded = graph_expand_search_conn(&conn, &hits, 5);
    // s-note-1 自身被排除；邻居（React 的关联源 s-note-2）的首块被追加
    assert_eq!(expanded.len(), 1);
    assert_eq!(expanded[0].source_id, "s-note-2");
    assert!(expanded[0].from_graph);
    assert_eq!(expanded[0].score, 0.0);
    // 无关源不进结果
    assert!(!expanded.iter().any(|h| h.source_id == "s-note-3"));
}

#[test]
fn manual_upsert_confidence_and_uniqueness() {
    let conn = setup_db();
    let id = graph_upsert_entity_conn(&conn, GraphEntityUpsertArgs {
        id: None, name: "手工实体".into(), r#type: "concept".into(), description: "d".into(),
    }).unwrap();
    // 同名（大小写不同）新建被拒
    assert!(graph_upsert_entity_conn(&conn, GraphEntityUpsertArgs {
        id: None, name: "手工实体".into(), r#type: "concept".into(), description: String::new(),
    }).is_err());
    // 手工关系 confidence=1.0；重复三元组被拒
    let _other = graph_upsert_entity_conn(&conn, GraphEntityUpsertArgs {
        id: None, name: "另一实体".into(), r#type: "concept".into(), description: String::new(),
    }).unwrap();
    let data = graph_get_conn(&conn).unwrap();
    graph_upsert_relation_conn(&conn, GraphRelationUpsertArgs {
        id: None, source_entity_id: id.clone(), target_entity_id: data.entities.iter().find(|e| e.name == "另一实体").unwrap().id.clone(),
        r#type: "related_to".into(), description: String::new(),
    }).unwrap();
    let after = graph_get_conn(&conn).unwrap();
    assert_eq!(after.relations[0].confidence, MANUAL_CONFIDENCE);
}
