//! 知识图谱（ROADMAP ⑩，Hetu GraphService 移植）：实体/关系两表存于
//! knowledge.db（与 RAG 同库独立表），LLM 抽取在前端（completeOneShotText，
//! 场景模型 graph→回退聊天默认），Rust 只负责去重落库与查询。
//!
//! 语义对齐 Hetu：
//! - 实体 5 类 concept/person/organization/technology/project（org/tech 别名归一），
//!   小写名全局去重（COLLATE NOCASE 唯一约束 + 代码层双保险）；
//! - 关系 5 类 belong_to/related_to/depends_on/contains/compared_with，
//!   (source,target,type) 三元组唯一；LLM 置信度 0.8、手工 1.0；
//! - 检索增强（1 跳扩展）：命中源 → 关联实体 → 邻居实体 → 邻居关联的其他源
//!   → 追加其最优 chunk（无分数排后，≤ top_k/2），无图谱数据自动跳过。

use crate::knowledge_index::{store, KnowledgeSearchHit};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const ENTITY_TYPES: [&str; 5] = ["concept", "person", "organization", "technology", "project"];
pub const RELATION_TYPES: [&str; 5] = ["belong_to", "related_to", "depends_on", "contains", "compared_with"];
/// LLM 偶尔返回缩写，归一化回完整类型名（Hetu 同款）
const ENTITY_TYPE_ALIASES: [(&str, &str); 2] = [("org", "organization"), ("tech", "technology")];
pub const LLM_CONFIDENCE: f64 = 0.8;
pub const MANUAL_CONFIDENCE: f64 = 1.0;

const GRAPH_SCHEMA_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS graph_entities (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    entity_type TEXT NOT NULL DEFAULT 'concept',
    description TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_entities_type ON graph_entities(entity_type);

CREATE TABLE IF NOT EXISTS graph_relations (
    id                TEXT PRIMARY KEY,
    source_entity_id  TEXT NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
    target_entity_id  TEXT NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
    relation_type     TEXT NOT NULL DEFAULT 'related_to',
    description       TEXT NOT NULL DEFAULT '',
    confidence        REAL NOT NULL DEFAULT 1.0,
    source_id         TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE (source_entity_id, target_entity_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_graph_relations_source_id ON graph_relations(source_id);
"#;

fn ensure_graph_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(GRAPH_SCHEMA_DDL)
        .map_err(|e| format!("graph schema 初始化失败：{e}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("ge-{}-{:x}-{}", now_ms(), std::process::id(), n)
}

/// 实体类型归一化：别名展开 + 封闭枚举外回落 concept
pub fn normalize_entity_type(raw: &str) -> String {
    let v = raw.trim().to_lowercase();
    if let Some((_, full)) = ENTITY_TYPE_ALIASES.iter().find(|(alias, _)| *alias == v) {
        return full.to_string();
    }
    if ENTITY_TYPES.contains(&v.as_str()) { v } else { "concept".to_string() }
}

/// LLM 常见偏差归一（belongs_to/depend_on 等更自然的英文变体 → 枚举值）
const RELATION_TYPE_ALIASES: [(&str, &str); 4] = [
    ("belongs_to", "belong_to"),
    ("depend_on", "depends_on"),
    ("contain", "contains"),
    ("compare_with", "compared_with"),
];

/// 关系类型归一化：别名展开 → 封闭枚举外回落 related_to
pub fn normalize_relation_type(raw: &str) -> String {
    let v = raw.trim().to_lowercase();
    if let Some((_, full)) = RELATION_TYPE_ALIASES.iter().find(|(alias, _)| *alias == v) {
        return full.to_string();
    }
    if RELATION_TYPES.contains(&v.as_str()) { v } else { "related_to".to_string() }
}

// ===== DTO =====

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphEntityDto {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub entity_type: String,
    pub description: String,
    pub relation_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphRelationDto {
    pub id: String,
    pub source_entity_id: String,
    pub source_entity_name: String,
    pub target_entity_id: String,
    pub target_entity_name: String,
    #[serde(rename = "type")]
    pub relation_type: String,
    pub description: String,
    pub confidence: f64,
    /// 关联知识源（笔记/导入会话）的 source_id；手工创建为 None
    pub source_id: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub entities: Vec<GraphEntityDto>,
    pub relations: Vec<GraphRelationDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractEntityInput {
    pub name: String,
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractRelationInput {
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub relation: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphApplyExtractionArgs {
    /// 关联知识源（可空——全库级抽取无单源归属）
    pub source_id: Option<String>,
    pub entities: Vec<ExtractEntityInput>,
    pub relations: Vec<ExtractRelationInput>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GraphExtractionResult {
    pub new_entities: i64,
    pub skipped_entities: i64,
    pub new_relations: i64,
    pub skipped_relations: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEntityUpsertArgs {
    /// 空 = 新建
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRelationUpsertArgs {
    pub id: Option<String>,
    pub source_entity_id: String,
    pub target_entity_id: String,
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMergeArgs {
    pub keep_id: String,
    pub merge_id: String,
}

// ===== 落库逻辑（conn 参数化以便测试） =====

fn entity_by_name(conn: &Connection, name: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id FROM graph_entities WHERE name = ?1 COLLATE NOCASE",
        [name.trim()],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// LLM 抽取结果去重落库（实体小写名全局去重 + 关系三元组去重；置信度 0.8）
pub fn graph_apply_extraction_conn(conn: &Connection, args: GraphApplyExtractionArgs) -> Result<GraphExtractionResult, String> {
    ensure_graph_schema(conn)?;
    let mut result = GraphExtractionResult::default();
    let now = now_ms();
    // name（原样大小写保存）→ id（本轮新建 + 库中已有）
    let mut known: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for e in &args.entities {
        let name = e.name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        if known.contains_key(&name) {
            result.skipped_entities += 1;
            continue;
        }
        if let Some(existing) = entity_by_name(&tx, &name)? {
            known.insert(name, existing);
            result.skipped_entities += 1;
            continue;
        }
        let id = new_id();
        tx.execute(
            "INSERT INTO graph_entities (id, name, entity_type, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, name, normalize_entity_type(&e.r#type), e.description.trim(), now],
        )
        .map_err(|er| er.to_string())?;
        known.insert(name, id);
        result.new_entities += 1;
    }

    for r in &args.relations {
        let source_name = r.source.trim();
        let target_name = r.target.trim();
        if source_name.is_empty() || target_name.is_empty() {
            continue;
        }
        let (Some(source_id), Some(target_id)) = (
            known.get(source_name).cloned().or_else(|| entity_by_name(&tx, source_name).ok().flatten()),
            known.get(target_name).cloned().or_else(|| entity_by_name(&tx, target_name).ok().flatten()),
        ) else {
            // 关系两端实体不在本轮也不在库中：跳过（不凭空造实体）
            result.skipped_relations += 1;
            continue;
        };
        if source_id == target_id {
            result.skipped_relations += 1;
            continue;
        }
        let rel_type = normalize_relation_type(&r.relation);
        let n = tx
            .execute(
                "INSERT OR IGNORE INTO graph_relations
                 (id, source_entity_id, target_entity_id, relation_type, description, confidence, source_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![new_id(), source_id, target_id, rel_type, r.description.trim(), LLM_CONFIDENCE, args.source_id, now],
            )
            .map_err(|er| er.to_string())?;
        if n > 0 {
            result.new_relations += 1;
        } else {
            result.skipped_relations += 1;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

fn load_entities(conn: &Connection) -> Result<Vec<GraphEntityDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.name, e.entity_type, e.description, e.created_at, e.updated_at,
                    (SELECT COUNT(*) FROM graph_relations r
                     WHERE r.source_entity_id = e.id OR r.target_entity_id = e.id)
             FROM graph_entities e ORDER BY e.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(GraphEntityDto {
                id: r.get(0)?,
                name: r.get(1)?,
                entity_type: r.get(2)?,
                description: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
                relation_count: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 全量图数据（可视化用；实体上限 2000 / 关系上限 6000 防爆）
pub fn graph_get_conn(conn: &Connection) -> Result<GraphData, String> {
    ensure_graph_schema(conn)?;
    let entities = load_entities(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT r.id, r.source_entity_id, r.target_entity_id, r.relation_type, r.description,
                    r.confidence, r.source_id, r.created_at
             FROM graph_relations r LIMIT 6000",
        )
        .map_err(|e| e.to_string())?;
    let mut name_of = std::collections::HashMap::new();
    for e in &entities {
        name_of.insert(e.id.clone(), e.name.clone());
    }
    let relations = stmt
        .query_map([], |r| {
            let sid: String = r.get(1)?;
            let tid: String = r.get(2)?;
            Ok(GraphRelationDto {
                id: r.get(0)?,
                source_entity_name: name_of.get(&sid).cloned().unwrap_or_default(),
                target_entity_name: name_of.get(&tid).cloned().unwrap_or_default(),
                source_entity_id: sid,
                target_entity_id: tid,
                relation_type: r.get(3)?,
                description: r.get(4)?,
                confidence: r.get(5)?,
                source_id: r.get(6)?,
                created_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut entities = entities;
    entities.truncate(2000);
    Ok(GraphData { entities, relations })
}

/// 删除某知识源关联的全部关系（笔记删除/重建索引前调用）
pub fn graph_delete_by_source_conn(conn: &Connection, source_id: &str) -> Result<u64, String> {
    ensure_graph_schema(conn)?;
    let n = conn
        .execute("DELETE FROM graph_relations WHERE source_id = ?1", [source_id])
        .map_err(|e| e.to_string())?;
    Ok(n as u64)
}

/// 删除实体（外键级联删两端关系）
pub fn graph_delete_entity_conn(conn: &Connection, id: &str) -> Result<(), String> {
    ensure_graph_schema(conn)?;
    conn.execute("DELETE FROM graph_entities WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 手工建/改实体
pub fn graph_upsert_entity_conn(conn: &Connection, args: GraphEntityUpsertArgs) -> Result<String, String> {
    ensure_graph_schema(conn)?;
    let name = args.name.trim();
    if name.is_empty() {
        return Err("实体名不能为空".into());
    }
    let now = now_ms();
    match args.id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => {
            let n = conn
                .execute(
                    "UPDATE graph_entities SET name = ?2, entity_type = ?3, description = ?4, updated_at = ?5 WHERE id = ?1",
                    params![id, name, normalize_entity_type(&args.r#type), args.description.trim(), now],
                )
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("实体不存在".into());
            }
            Ok(id.to_string())
        }
        None => {
            if entity_by_name(conn, name)?.is_some() {
                return Err("同名实体已存在（实体名全局唯一，不区分大小写）".into());
            }
            let id = new_id();
            conn.execute(
                "INSERT INTO graph_entities (id, name, entity_type, description, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![id, name, normalize_entity_type(&args.r#type), args.description.trim(), now],
            )
            .map_err(|e| e.to_string())?;
            Ok(id)
        }
    }
}

/// 手工建关系（confidence=1.0）
pub fn graph_upsert_relation_conn(conn: &Connection, args: GraphRelationUpsertArgs) -> Result<String, String> {
    ensure_graph_schema(conn)?;
    if args.source_entity_id == args.target_entity_id {
        return Err("关系两端不能是同一实体".into());
    }
    let rel_type = normalize_relation_type(&args.r#type);
    let now = now_ms();
    let n = conn
        .execute(
            "INSERT OR IGNORE INTO graph_relations
             (id, source_entity_id, target_entity_id, relation_type, description, confidence, source_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
            params![new_id(), args.source_entity_id, args.target_entity_id, rel_type, args.description.trim(), MANUAL_CONFIDENCE, now],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("相同关系已存在（同实体对 + 同类型）".into());
    }
    Ok(String::new())
}

pub fn graph_delete_relation_conn(conn: &Connection, id: &str) -> Result<(), String> {
    ensure_graph_schema(conn)?;
    conn.execute("DELETE FROM graph_relations WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 合并实体：merge 的关系全部改挂 keep（自环删除），merge 实体删除
pub fn graph_merge_entities_conn(conn: &Connection, args: GraphMergeArgs) -> Result<(), String> {
    ensure_graph_schema(conn)?;
    if args.keep_id == args.merge_id {
        return Err("不能合并同一实体".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE OR IGNORE graph_relations SET source_entity_id = ?2, updated_at = ?3 WHERE source_entity_id = ?1",
        params![args.merge_id, args.keep_id, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE OR IGNORE graph_relations SET target_entity_id = ?2, updated_at = ?3 WHERE target_entity_id = ?1",
        params![args.merge_id, args.keep_id, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    // 改挂后产生的自环与重复三元组一并清理（重复保留最早一条）
    tx.execute("DELETE FROM graph_relations WHERE source_entity_id = target_entity_id", [])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM graph_relations WHERE id NOT IN (
            SELECT MIN(id) FROM graph_relations
            GROUP BY source_entity_id, target_entity_id, relation_type
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM graph_entities WHERE id = ?1", [&args.merge_id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 实体搜索（名/描述 LIKE；type 过滤；上限 topK）
pub fn graph_search_entities_conn(conn: &Connection, query: &str, entity_type: Option<&str>, top_k: usize) -> Result<Vec<GraphEntityDto>, String> {
    ensure_graph_schema(conn)?;
    let pattern = format!("%{}%", query.trim());
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.name, e.entity_type, e.description, e.created_at, e.updated_at,
                    (SELECT COUNT(*) FROM graph_relations r
                     WHERE r.source_entity_id = e.id OR r.target_entity_id = e.id)
             FROM graph_entities e
             WHERE (e.name LIKE ?1 OR e.description LIKE ?1)
               AND (?2 IS NULL OR e.entity_type = ?2)
             ORDER BY e.name COLLATE NOCASE LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![pattern, entity_type, top_k as i64], |r| {
            Ok(GraphEntityDto {
                id: r.get(0)?,
                name: r.get(1)?,
                entity_type: r.get(2)?,
                description: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
                relation_count: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 检索 1 跳扩展（Hetu EnhanceWithGraph 同构）：
/// 命中 source → 其关联实体 → 1 跳邻居实体 → 邻居关联的其他 source
/// → 追加这些 source 的最优 chunk（score=0 排后、fromGraph=true，上限 top_k/2）
pub fn graph_expand_search_conn(conn: &Connection, hits: &[KnowledgeSearchHit], top_k: usize) -> Vec<KnowledgeSearchHit> {
    if hits.is_empty() || ensure_graph_schema(conn).is_err() {
        return Vec::new();
    }
    let hit_sources: std::collections::HashSet<&str> = hits.iter().map(|h| h.source_id.as_str()).collect();

    // 1) 命中源关联的实体
    let seed_entities: Vec<String> = {
        let mut stmt = match conn.prepare(
            "SELECT DISTINCT source_entity_id FROM graph_relations WHERE source_id IS NOT NULL AND source_id IN (
                 SELECT value FROM json_each(?1)
             ) UNION
             SELECT DISTINCT target_entity_id FROM graph_relations WHERE source_id IS NOT NULL AND source_id IN (
                 SELECT value FROM json_each(?1)
             )",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map([serde_json::to_string(&hit_sources).unwrap_or_default()], |r| r.get::<_, String>(0)) {
            Ok(rows) => rows,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(Result::ok).collect()
    };
    if seed_entities.is_empty() {
        return Vec::new();
    }

    // 2) 1 跳邻居（排除种子自身）
    let neighbors: Vec<String> = {
        let Ok(seeds_json) = serde_json::to_string(&seed_entities) else { return Vec::new() };
        let mut stmt = match conn.prepare(
            "SELECT DISTINCT eid FROM (
                 SELECT target_entity_id AS eid FROM graph_relations WHERE source_entity_id IN (SELECT value FROM json_each(?1))
                 UNION
                 SELECT source_entity_id AS eid FROM graph_relations WHERE target_entity_id IN (SELECT value FROM json_each(?1))
             ) WHERE eid NOT IN (SELECT value FROM json_each(?1))",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map([seeds_json], |r| r.get::<_, String>(0)) {
            Ok(rows) => rows,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(Result::ok).collect()
    };
    if neighbors.is_empty() {
        return Vec::new();
    }

    // 3) 邻居实体关联的其他 source（不在原命中集），各取最高分 chunk（图谱分固定 0.0）
    let limit = (top_k / 2).max(1) as i64;
    let Ok(nb_json) = serde_json::to_string(&neighbors) else { return Vec::new() };
    let mut stmt = match conn.prepare(
        "SELECT s.source_id, s.source_type, s.title, s.source_path,
                c.chunk_index, c.heading_path, c.content
         FROM (
             SELECT DISTINCT source_id FROM graph_relations
             WHERE source_id IS NOT NULL
               AND (source_entity_id IN (SELECT value FROM json_each(?1))
                 OR target_entity_id IN (SELECT value FROM json_each(?1)))
         ) g
         JOIN knowledge_sources s ON s.source_id = g.source_id AND s.status = 'ok'
         JOIN knowledge_chunks c ON c.source_id = g.source_id
         WHERE c.chunk_index = 0
           AND g.source_id NOT IN (SELECT value FROM json_each(?2))
         LIMIT ?3",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let sources_json = serde_json::to_string(&hit_sources).unwrap_or_default();
    let rows = match stmt.query_map(params![nb_json, sources_json, limit], |r| {
        Ok(KnowledgeSearchHit {
            source_id: r.get(0)?,
            source_type: r.get(1)?,
            title: r.get(2)?,
            source_path: r.get(3)?,
            chunk_index: r.get::<_, i64>(4)? as usize,
            heading_path: r.get(5)?,
            content: r.get(6)?,
            score: 0.0,
            from_graph: true,
        })
    }) {
        Ok(rows) => rows.filter_map(Result::ok).collect(),
        Err(_) => return Vec::new(),
    };
    rows
}

// ===== Tauri 命令 =====

#[tauri::command]
pub async fn graph_get() -> Result<GraphData, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    graph_get_conn(&conn)
}

#[tauri::command]
pub async fn graph_apply_extraction(args: GraphApplyExtractionArgs) -> Result<GraphExtractionResult, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    graph_apply_extraction_conn(&conn, args)
}

#[tauri::command]
pub async fn graph_delete_by_source(source_id: String) -> Result<u64, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    graph_delete_by_source_conn(&conn, &source_id)
}

#[tauri::command]
pub async fn graph_delete_entity(id: String) -> Result<(), String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    graph_delete_entity_conn(&conn, &id)
}

#[tauri::command]
pub async fn graph_upsert_entity(args: GraphEntityUpsertArgs) -> Result<String, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    graph_upsert_entity_conn(&conn, args)
}

#[tauri::command]
pub async fn graph_upsert_relation(args: GraphRelationUpsertArgs) -> Result<String, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    graph_upsert_relation_conn(&conn, args)
}

#[tauri::command]
pub async fn graph_delete_relation(id: String) -> Result<(), String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    graph_delete_relation_conn(&conn, &id)
}

#[tauri::command]
pub async fn graph_merge_entities(args: GraphMergeArgs) -> Result<(), String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    graph_merge_entities_conn(&conn, args)
}

#[tauri::command]
pub async fn graph_search_entities(query: String, entity_type: Option<String>, top_k: Option<usize>) -> Result<Vec<GraphEntityDto>, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    graph_search_entities_conn(&conn, &query, entity_type.as_deref(), top_k.unwrap_or(20))
}
