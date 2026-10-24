//! 知识库索引（RAG v1）：独立 SQLite 库 + 暴力余弦检索。
//!
//! 架构分工（对齐 docs/ROADMAP.md ①）：TS 侧负责分块、增量比对与 embedding
//! HTTP 编排；本模块只做三件事——数据源指纹扫描（笔记文件 + 导入任务）、
//! 向量存储（f32 LE BLOB）、余弦 top-K 检索。
//!
//! 设计预留 sqlite-vec 升级位：`knowledge_chunks.embedding/dims` 列语义与
//! vec0 虚表一致，后续引入扩展时只需加虚表 + 双写同步，业务表与命令不动。
//! 检索实现 v1 为 spawn_blocking 内全量余弦（桌面语料毫秒级），带进程内
//! 向量缓存（写操作失效）。
//!
//! No-Fallback：库损坏 → 隔离重建（照 memory 模块）；embedding 模型/维度
//! 变更 → 显式报错要求重建，严禁混维检索；扫描/存储失败一律上抛。

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const KNOWLEDGE_DIR_NAME: &str = ".ReinAgent";
const KNOWLEDGE_ROOT_DIR: &str = "knowledge";
const DB_FILENAME: &str = "knowledge-index.sqlite3";
const STATE_KEY_MODEL_ID: &str = "embedding_model_id";
const STATE_KEY_DIMS: &str = "embedding_dims";
const DEFAULT_TOP_K: usize = 5;
const MAX_TOP_K: usize = 32;

const KNOWLEDGE_SCHEMA_DDL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS knowledge_sources (
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
    last_indexed_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_type
    ON knowledge_sources(source_type, last_indexed_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id    TEXT    NOT NULL REFERENCES knowledge_sources(source_id) ON DELETE CASCADE,
    chunk_index  INTEGER NOT NULL,
    heading_path TEXT    NOT NULL DEFAULT '',
    content      TEXT    NOT NULL,
    embedding    BLOB    NOT NULL,
    dims         INTEGER NOT NULL,
    UNIQUE (source_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source
    ON knowledge_chunks(source_id);

CREATE TABLE IF NOT EXISTS knowledge_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO knowledge_schema_version (version, applied_at)
VALUES (1, strftime('%s','now') * 1000);
"#;

// ==================== DTO（serde camelCase，前端契约）====================

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeScanRow {
    pub source_id: String,
    /// 'note' | 'import'
    pub source_type: String,
    pub title: String,
    pub source_path: String,
    /// 笔记 = "mtime_ms:size"；导入任务 = "msg_count:max_seq"
    pub fingerprint: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSourceMeta {
    pub source_id: String,
    pub source_type: String,
    pub title: String,
    pub source_path: String,
    pub fingerprint: String,
    pub chunk_count: i64,
    pub status: String,
    pub error: Option<String>,
    pub model_id: String,
    pub dims: Option<i64>,
    pub last_indexed_at: i64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeUpsertSource {
    pub id: String,
    pub source_type: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub source_path: String,
    #[serde(default)]
    pub fingerprint: String,
    /// 'ok' | 'error'
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeUpsertChunk {
    pub index: usize,
    #[serde(default)]
    pub heading_path: String,
    pub content: String,
    pub embedding: Vec<f32>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeUpsertArgs {
    pub source: KnowledgeUpsertSource,
    pub chunks: Vec<KnowledgeUpsertChunk>,
    pub model_id: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChunkRow {
    pub index: usize,
    pub heading_path: String,
    pub content: String,
    pub embedding: Vec<f32>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchArgs {
    pub query_embedding: Vec<f32>,
    #[serde(default)]
    pub top_k: Option<usize>,
    /// 'note' | 'import'，缺省 = 全部
    #[serde(default)]
    pub source_type: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchHit {
    pub source_id: String,
    pub source_type: String,
    pub title: String,
    pub source_path: String,
    pub chunk_index: usize,
    pub heading_path: String,
    pub content: String,
    pub score: f32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeStats {
    pub note_count: i64,
    pub import_count: i64,
    pub chunk_count: i64,
    pub error_count: i64,
    pub dims: Option<i64>,
    pub model_id: String,
    pub last_indexed_at: Option<i64>,
}

// ==================== 纯函数（Red Check 目标）====================

/// 余弦相似度。`vec_norm` 为 `b` 的预计算 L2 范数（缓存期算好），
/// `a`（查询向量）的范数在调用方算一次。
fn cosine_with_norm(a: &[f32], b: &[f32], b_norm: f32) -> f32 {
    if a.len() != b.len() || b_norm <= 0.0 {
        return 0.0;
    }
    let mut dot = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
    }
    let a_norm = l2_norm(a);
    if a_norm <= 0.0 {
        return 0.0;
    }
    dot / (a_norm * b_norm)
}

fn l2_norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

fn f32_vec_to_le_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn le_bytes_to_f32_vec(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ==================== Store =====================

struct CacheEntry {
    pk: i64,
    source_type: String,
    embedding: Vec<f32>,
    norm: f32,
    dims: usize,
}

struct VectorCache {
    entries: Vec<CacheEntry>,
}

pub struct KnowledgeStore {
    conn: Mutex<Connection>,
    vector_cache: RwLock<Option<Arc<VectorCache>>>,
}

static KNOWLEDGE_STORE: OnceLock<Arc<KnowledgeStore>> = OnceLock::new();

/// 全局知识库单例：首次访问时打开 `~/.ReinAgent/knowledge/`。
/// 打开失败直接 panic（No-Fallback：严禁静默兜底）。
pub fn store() -> &'static Arc<KnowledgeStore> {
    KNOWLEDGE_STORE.get_or_init(|| match KnowledgeStore::open() {
        Ok(store) => Arc::new(store),
        Err(error) => panic!("knowledge store 初始化失败（~/.ReinAgent/knowledge）：{error}"),
    })
}

fn knowledge_root_dir() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("HOME") {
        return Ok(PathBuf::from(home).join(KNOWLEDGE_DIR_NAME).join(KNOWLEDGE_ROOT_DIR));
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        return Ok(PathBuf::from(profile)
            .join(KNOWLEDGE_DIR_NAME)
            .join(KNOWLEDGE_ROOT_DIR));
    }
    Err("无法定位用户主目录（HOME/USERPROFILE 均未设置）".to_string())
}

impl KnowledgeStore {
    pub fn open() -> Result<Self, String> {
        let root = knowledge_root_dir()?;
        fs::create_dir_all(&root).map_err(|e| format!("创建知识库目录失败：{e}"))?;
        let db_path = root.join(DB_FILENAME);
        let conn = open_knowledge_connection(&db_path)?;
        Ok(Self {
            conn: Mutex::new(conn),
            vector_cache: RwLock::new(None),
        })
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn.lock().map_err(|e| format!("knowledge store 锁获取失败：{e}"))
    }

    fn invalidate_cache(&self) {
        if let Ok(mut guard) = self.vector_cache.write() {
            *guard = None;
        }
    }

    fn get_cached_vectors(&self) -> Result<Arc<VectorCache>, String> {
        if let Some(cache) = self.vector_cache.read().ok().and_then(|g| g.clone()) {
            return Ok(cache);
        }
        let conn = self.lock_conn()?;
        let mut entries = Vec::new();
        let mut stmt = conn
            .prepare(
                "SELECT c.id, s.source_type, c.embedding
                 FROM knowledge_chunks c
                 JOIN knowledge_sources s ON s.source_id = c.source_id",
            )
            .map_err(|e| format!("读取向量缓存失败：{e}"))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(|e| format!("读取向量缓存失败：{e}"))?;
        for row in mapped {
            let (pk, source_type, bytes) = row.map_err(|e| format!("读取向量缓存行失败：{e}"))?;
            let embedding = le_bytes_to_f32_vec(&bytes);
            let norm = l2_norm(&embedding);
            entries.push(CacheEntry {
                pk,
                source_type,
                norm,
                dims: embedding.len(),
                embedding,
            });
        }
        let cache = Arc::new(VectorCache { entries });
        if let Ok(mut guard) = self.vector_cache.write() {
            *guard = Some(cache.clone());
        }
        Ok(cache)
    }

    // ---------------- 状态（model/dims）----------------

    fn state_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
        conn.query_row(
            "SELECT value FROM knowledge_state WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 knowledge_state 失败：{e}"))
    }

    fn state_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
        conn.execute(
            "INSERT INTO knowledge_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
        .map_err(|e| format!("写入 knowledge_state 失败：{e}"))?;
        Ok(())
    }

    // ---------------- 源扫描 ----------------

    /// 扫描全部可索引数据源（笔记文件 + 导入任务）。
    /// 只读元数据与指纹，不读正文（正文由 TS 侧按需拉取）。
    pub fn scan_sources(&self) -> Result<Vec<KnowledgeScanRow>, String> {
        let mut rows = Vec::new();
        rows.extend(self.scan_note_sources()?);
        rows.extend(self.scan_import_sources()?);
        Ok(rows)
    }

    fn scan_note_sources(&self) -> Result<Vec<KnowledgeScanRow>, String> {
        let root = crate::notes_fs::get_notebooks_root();
        let mut rows = Vec::new();
        if !root.exists() {
            return Ok(rows);
        }
        let walker = walkdir::WalkDir::new(&root)
            .max_depth(16)
            .into_iter()
            .filter_entry(|e| {
                // 与 notes_fs 一致：跳过 `.` 开头目录
                !e.file_name().to_string_lossy().starts_with('.')
            });
        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue, // 单项遍历失败不阻断扫描
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.ends_with(".md") || name.ends_with(".markdown")) {
                continue;
            }
            let path = entry.path();
            let rel = match path.strip_prefix(&root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let notebook_rel = rel
                .parent()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let source_id = if notebook_rel.is_empty() {
                name.clone()
            } else {
                format!("{notebook_rel}:{name}")
            };
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let title = name
                .trim_end_matches(".markdown")
                .trim_end_matches(".md")
                .to_string();
            rows.push(KnowledgeScanRow {
                source_id,
                source_type: "note".to_string(),
                title,
                source_path: path.to_string_lossy().to_string(),
                fingerprint: format!("{mtime_ms}:{}", meta.len()),
            });
        }
        Ok(rows)
    }

    fn scan_import_sources(&self) -> Result<Vec<KnowledgeScanRow>, String> {
        let conn = crate::conversation_store::db_conn()?;
        let mut stmt = conn
            .prepare("SELECT id, payload FROM task WHERE id LIKE 'import-%' ORDER BY id ASC")
            .map_err(|e| format!("查询导入任务失败：{e}"))?;
        let mapped = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| format!("查询导入任务失败：{e}"))?;
        let mut rows = Vec::new();
        for row in mapped {
            let (task_id, payload) = row.map_err(|e| format!("读取导入任务失败：{e}"))?;
            let title = serde_json::from_str::<serde_json::Value>(&payload)
                .ok()
                .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(ToString::to_string))
                .unwrap_or_else(|| task_id.clone());
            let (msg_count, max_seq): (i64, i64) = conn
                .query_row(
                    "SELECT COUNT(*), COALESCE(MAX(seq), 0) FROM message WHERE task_id = ?1",
                    [&task_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|e| format!("统计导入任务消息失败：{e}"))?;
            rows.push(KnowledgeScanRow {
                source_id: task_id,
                source_type: "import".to_string(),
                title,
                source_path: String::new(),
                fingerprint: format!("{msg_count}:{max_seq}"),
            });
        }
        Ok(rows)
    }

    // ---------------- 索引写入 ----------------

    pub fn upsert_source(&self, args: KnowledgeUpsertArgs) -> Result<KnowledgeSourceMeta, String> {
        if args.source.source_type != "note" && args.source.source_type != "import" {
            return Err(format!("非法知识源类型：{}", args.source.source_type));
        }
        if args.source.status != "ok" && args.source.status != "error" {
            return Err(format!("非法知识源状态：{}", args.source.status));
        }
        let dims = args.chunks.first().map(|c| c.embedding.len());
        if let Some(d) = dims {
            for chunk in &args.chunks {
                if chunk.embedding.len() != d {
                    return Err(format!(
                        "源 {} 内向量维度不一致（{} vs {d}）",
                        args.source.id,
                        chunk.embedding.len()
                    ));
                }
            }
        }
        if !args.chunks.is_empty() && args.model_id.trim().is_empty() {
            return Err("带向量块的上传必须携带 model_id".to_string());
        }

        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启索引事务失败：{e}"))?;
        // 模型/维度一致性：已有状态时不允许混模型写入（fail-fast，要求清空重建）
        let existing_model = Self::state_get(&tx, STATE_KEY_MODEL_ID)?;
        if let Some(existing) = existing_model {
            if !args.chunks.is_empty() && existing != args.model_id {
                return Err(format!(
                    "embedding 模型已变更（索引：{existing}，本次：{}）——请先清空索引再全量重建",
                    args.model_id
                ));
            }
        }
        let existing_dims: Option<i64> = Self::state_get(&tx, STATE_KEY_DIMS)?
            .and_then(|v| v.parse().ok());
        if let (Some(existing), Some(d)) = (existing_dims, dims) {
            if existing != d as i64 {
                return Err(format!(
                    "embedding 维度已变更（索引：{existing}，本次：{d}）——请先清空索引再全量重建"
                ));
            }
        }

        tx.execute(
            "DELETE FROM knowledge_chunks WHERE source_id = ?1",
            [&args.source.id],
        )
        .map_err(|e| format!("清理旧索引块失败：{e}"))?;
        tx.execute(
            "DELETE FROM knowledge_sources WHERE source_id = ?1",
            [&args.source.id],
        )
        .map_err(|e| format!("清理旧索引源失败：{e}"))?;
        tx.execute(
            "INSERT INTO knowledge_sources
             (source_id, source_type, title, source_path, fingerprint, chunk_count, status, error, model_id, dims, last_indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                args.source.id,
                args.source.source_type,
                args.source.title,
                args.source.source_path,
                args.source.fingerprint,
                args.chunks.len() as i64,
                args.source.status,
                args.source.error,
                args.model_id,
                dims.map(|d| d as i64),
                now_ms(),
            ],
        )
        .map_err(|e| format!("写入索引源失败：{e}"))?;
        for chunk in &args.chunks {
            tx.execute(
                "INSERT INTO knowledge_chunks (source_id, chunk_index, heading_path, content, embedding, dims)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    args.source.id,
                    chunk.index as i64,
                    chunk.heading_path,
                    chunk.content,
                    f32_vec_to_le_bytes(&chunk.embedding),
                    chunk.embedding.len() as i64,
                ],
            )
            .map_err(|e| format!("写入索引块失败：{e}"))?;
        }
        if let Some(d) = dims {
            Self::state_set(&tx, STATE_KEY_MODEL_ID, args.model_id.trim())?;
            Self::state_set(&tx, STATE_KEY_DIMS, &d.to_string())?;
        }
        tx.commit()
            .map_err(|e| format!("提交索引事务失败：{e}"))?;
        drop(conn);
        self.invalidate_cache();
        self.source_meta(&args.source.id)
    }

    pub fn source_meta(&self, source_id: &str) -> Result<KnowledgeSourceMeta, String> {
        let conn = self.lock_conn()?;
        conn.query_row(
            "SELECT source_id, source_type, title, source_path, fingerprint, chunk_count, status, error, model_id, dims, last_indexed_at
             FROM knowledge_sources WHERE source_id = ?1",
            [source_id],
            row_to_source_meta,
        )
        .optional()
        .map_err(|e| format!("读取索引源失败：{e}"))?
        .ok_or_else(|| format!("索引源不存在：{source_id}"))
    }

    pub fn list_sources(&self) -> Result<Vec<KnowledgeSourceMeta>, String> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT source_id, source_type, title, source_path, fingerprint, chunk_count, status, error, model_id, dims, last_indexed_at
                 FROM knowledge_sources ORDER BY source_type ASC, source_id ASC",
            )
            .map_err(|e| format!("列出索引源失败：{e}"))?;
        let mapped = stmt
            .query_map([], row_to_source_meta)
            .map_err(|e| format!("列出索引源失败：{e}"))?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(|e| format!("读取索引源失败：{e}"))
    }

    pub fn get_chunks(&self, source_id: &str) -> Result<Vec<KnowledgeChunkRow>, String> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT chunk_index, heading_path, content, embedding
                 FROM knowledge_chunks WHERE source_id = ?1 ORDER BY chunk_index ASC",
            )
            .map_err(|e| format!("读取索引块失败：{e}"))?;
        let mapped = stmt
            .query_map([source_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            })
            .map_err(|e| format!("读取索引块失败：{e}"))?;
        let mut rows = Vec::new();
        for row in mapped {
            let (index, heading_path, content, bytes) =
                row.map_err(|e| format!("读取索引块行失败：{e}"))?;
            rows.push(KnowledgeChunkRow {
                index: index.max(0) as usize,
                heading_path,
                content,
                embedding: le_bytes_to_f32_vec(&bytes),
            });
        }
        Ok(rows)
    }

    pub fn delete_source(&self, source_id: &str) -> Result<(), String> {
        let conn = self.lock_conn()?;
        conn.execute("DELETE FROM knowledge_chunks WHERE source_id = ?1", [source_id])
            .map_err(|e| format!("删除索引块失败：{e}"))?;
        conn.execute("DELETE FROM knowledge_sources WHERE source_id = ?1", [source_id])
            .map_err(|e| format!("删除索引源失败：{e}"))?;
        drop(conn);
        self.invalidate_cache();
        Ok(())
    }

    pub fn clear_index(&self) -> Result<(), String> {
        let conn = self.lock_conn()?;
        conn.execute("DELETE FROM knowledge_chunks", [])
            .map_err(|e| format!("清空索引块失败：{e}"))?;
        conn.execute("DELETE FROM knowledge_sources", [])
            .map_err(|e| format!("清空索引源失败：{e}"))?;
        conn.execute("DELETE FROM knowledge_state", [])
            .map_err(|e| format!("清空索引状态失败：{e}"))?;
        drop(conn);
        self.invalidate_cache();
        Ok(())
    }

    pub fn stats(&self) -> Result<KnowledgeStats, String> {
        let conn = self.lock_conn()?;
        let (note_count, import_count, error_count): (i64, i64, i64) = conn
            .query_row(
                "SELECT
                    COALESCE(SUM(source_type = 'note'), 0),
                    COALESCE(SUM(source_type = 'import'), 0),
                    COALESCE(SUM(status = 'error'), 0)
                 FROM knowledge_sources",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| format!("统计索引源失败：{e}"))?;
        let (chunk_count,): (i64,) = conn
            .query_row(
                "SELECT COUNT(*) FROM knowledge_chunks",
                [],
                |row| Ok((row.get(0)?,)),
            )
            .map_err(|e| format!("统计索引块失败：{e}"))?;
        let dims: Option<i64> = Self::state_get(&conn, STATE_KEY_DIMS)?
            .and_then(|v| v.parse().ok());
        let model_id = Self::state_get(&conn, STATE_KEY_MODEL_ID)?.unwrap_or_default();
        let last_indexed_at: Option<i64> = conn
            .query_row(
                "SELECT MAX(last_indexed_at) FROM knowledge_sources",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("统计最后索引时间失败：{e}"))?
            .flatten();
        Ok(KnowledgeStats {
            note_count,
            import_count,
            chunk_count,
            error_count,
            dims,
            model_id,
            last_indexed_at,
        })
    }

    // ---------------- 检索 ----------------

    pub fn search(&self, args: KnowledgeSearchArgs) -> Result<Vec<KnowledgeSearchHit>, String> {
        if args.query_embedding.is_empty() {
            return Err("查询向量为空".to_string());
        }
        let top_k = args.top_k.unwrap_or(DEFAULT_TOP_K).clamp(1, MAX_TOP_K);
        let cache = self.get_cached_vectors()?;
        if cache.entries.is_empty() {
            return Ok(Vec::new());
        }
        let dims_match = cache.entries.iter().any(|e| e.dims == args.query_embedding.len());
        if !dims_match {
            let index_dims = cache.entries.first().map(|e| e.dims).unwrap_or(0);
            return Err(format!(
                "embedding 维度不符（索引 {index_dims} 维，查询 {} 维）——请清空索引后全量重建",
                args.query_embedding.len()
            ));
        }

        struct Scored {
            pk: i64,
            score: f32,
        }
        let mut scored: Vec<Scored> = Vec::new();
        for entry in &cache.entries {
            if entry.dims != args.query_embedding.len() {
                continue;
            }
            if let Some(filter) = args.source_type.as_deref() {
                if entry.source_type != filter {
                    continue;
                }
            }
            let score = cosine_with_norm(&args.query_embedding, &entry.embedding, entry.norm);
            scored.push(Scored { pk: entry.pk, score });
        }
        if scored.is_empty() {
            return Ok(Vec::new());
        }
        if scored.len() > top_k {
            scored.select_nth_unstable_by(top_k - 1, |a, b| b.score.total_cmp(&a.score));
            scored.truncate(top_k);
        }
        scored.sort_by(|a, b| b.score.total_cmp(&a.score));

        let conn = self.lock_conn()?;
        let mut hits = Vec::with_capacity(scored.len());
        {
            let mut stmt = conn
                .prepare(
                    "SELECT c.chunk_index, c.heading_path, c.content, s.source_id, s.source_type, s.title, s.source_path
                     FROM knowledge_chunks c
                     JOIN knowledge_sources s ON s.source_id = c.source_id
                     WHERE c.id = ?1",
                )
                .map_err(|e| format!("读取检索命中失败：{e}"))?;
            for item in &scored {
                let row = stmt
                    .query_row([item.pk], |row| {
                        Ok(KnowledgeSearchHit {
                            chunk_index: row.get::<_, i64>(0)?.max(0) as usize,
                            heading_path: row.get(1)?,
                            content: row.get(2)?,
                            source_id: row.get(3)?,
                            source_type: row.get(4)?,
                            title: row.get(5)?,
                            source_path: row.get(6)?,
                            score: item.score,
                        })
                    })
                    .optional()
                    .map_err(|e| format!("读取检索命中的源信息失败：{e}"))?;
                if let Some(hit) = row {
                    hits.push(hit);
                }
            }
        }
        Ok(hits)
    }
}

fn row_to_source_meta(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<KnowledgeSourceMeta> {
    Ok(KnowledgeSourceMeta {
        source_id: row.get(0)?,
        source_type: row.get(1)?,
        title: row.get(2)?,
        source_path: row.get(3)?,
        fingerprint: row.get(4)?,
        chunk_count: row.get(5)?,
        status: row.get(6)?,
        error: row.get(7)?,
        model_id: row.get(8)?,
        dims: row.get(9)?,
        last_indexed_at: row.get(10)?,
    })
}

fn open_knowledge_connection(db_path: &PathBuf) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建知识库目录失败：{e}"))?;
    }
    let conn = Connection::open(db_path).map_err(|e| format!("打开知识库失败：{e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("设置知识库 busy_timeout 失败：{e}"))?;
    if let Err(error) = integrity_check(&conn) {
        quarantine_db_files(db_path)?;
        drop(conn);
        let conn = Connection::open(db_path).map_err(|e| format!("重建知识库失败：{e}"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("设置知识库 busy_timeout 失败：{e}"))?;
        conn.execute_batch(KNOWLEDGE_SCHEMA_DDL)
            .map_err(|e| format!("重建知识库表失败：{e}"))?;
        eprintln!("knowledge index was quarantined and rebuilt: {error}");
        return Ok(conn);
    }
    conn.execute_batch(KNOWLEDGE_SCHEMA_DDL)
        .map_err(|e| format!("初始化知识库表失败：{e}"))?;
    Ok(conn)
}

fn integrity_check(conn: &Connection) -> Result<(), String> {
    let result: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| format!("知识库 integrity_check 失败：{e}"))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(result)
    }
}

fn quarantine_db_files(db_path: &PathBuf) -> Result<(), String> {
    let parent = db_path.parent().ok_or("知识库路径异常")?;
    let quarantine = parent.join(".quarantine").join(format!(
        "corrupt-{}",
        now_ms()
    ));
    fs::create_dir_all(&quarantine).map_err(|e| format!("创建知识库隔离目录失败：{e}"))?;
    for suffix in ["", "-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{suffix}", db_path.display()));
        if from.exists() {
            let file_name = from.file_name().ok_or("知识库文件名异常")?;
            fs::rename(&from, quarantine.join(file_name))
                .map_err(|e| format!("隔离知识库文件失败：{e}"))?;
        }
    }
    Ok(())
}

// ==================== Tauri 命令 =====================

async fn knowledge_spawn_blocking<T, F>(command: &str, task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("{command} join 失败：{e}"))?
}

#[tauri::command]
pub async fn knowledge_scan_sources() -> Result<Vec<KnowledgeScanRow>, String> {
    knowledge_spawn_blocking("knowledge_scan_sources", move || store().scan_sources()).await
}

#[tauri::command]
pub async fn knowledge_list_sources() -> Result<Vec<KnowledgeSourceMeta>, String> {
    knowledge_spawn_blocking("knowledge_list_sources", move || store().list_sources()).await
}

#[tauri::command]
pub async fn knowledge_index_upsert(args: KnowledgeUpsertArgs) -> Result<KnowledgeSourceMeta, String> {
    knowledge_spawn_blocking("knowledge_index_upsert", move || store().upsert_source(args)).await
}

#[tauri::command]
pub async fn knowledge_get_chunks(source_id: String) -> Result<Vec<KnowledgeChunkRow>, String> {
    knowledge_spawn_blocking("knowledge_get_chunks", move || store().get_chunks(&source_id)).await
}

#[tauri::command]
pub async fn knowledge_index_delete_source(source_id: String) -> Result<(), String> {
    knowledge_spawn_blocking("knowledge_index_delete_source", move || {
        store().delete_source(&source_id)
    })
    .await
}

#[tauri::command]
pub async fn knowledge_index_clear() -> Result<(), String> {
    knowledge_spawn_blocking("knowledge_index_clear", move || store().clear_index()).await
}

#[tauri::command]
pub async fn knowledge_search(args: KnowledgeSearchArgs) -> Result<Vec<KnowledgeSearchHit>, String> {
    knowledge_spawn_blocking("knowledge_search", move || store().search(args)).await
}

#[tauri::command]
pub async fn knowledge_stats() -> Result<KnowledgeStats, String> {
    knowledge_spawn_blocking("knowledge_stats", move || store().stats()).await
}

// ==================== 测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> KnowledgeStore {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("knowledge");
        fs::create_dir_all(&root).expect("root dirs");
        let db_path = root.join(DB_FILENAME);
        let conn = open_knowledge_connection(&db_path).expect("open db");
        let store = KnowledgeStore {
            conn: Mutex::new(conn),
            vector_cache: RwLock::new(None),
        };
        std::mem::forget(temp);
        store
    }

    fn source_args(id: &str, source_type: &str) -> KnowledgeUpsertSource {
        KnowledgeUpsertSource {
            id: id.to_string(),
            source_type: source_type.to_string(),
            title: format!("title-{id}"),
            source_path: format!("/tmp/{id}.md"),
            fingerprint: "1:1".to_string(),
            status: "ok".to_string(),
            error: None,
        }
    }

    fn upsert_args(id: &str, source_type: &str, model: &str, vectors: &[Vec<f32>]) -> KnowledgeUpsertArgs {
        KnowledgeUpsertArgs {
            source: source_args(id, source_type),
            chunks: vectors
                .iter()
                .enumerate()
                .map(|(i, v)| KnowledgeUpsertChunk {
                    index: i,
                    heading_path: String::new(),
                    content: format!("chunk-{i} of {id}"),
                    embedding: v.clone(),
                })
                .collect(),
            model_id: model.to_string(),
        }
    }

    #[test]
    fn cosine_identical_orthogonal_opposite() {
        let a = vec![1.0, 0.0];
        let b = vec![1.0, 0.0];
        let c = vec![0.0, 1.0];
        let d = vec![-1.0, 0.0];
        let bn = l2_norm(&b);
        assert!((cosine_with_norm(&a, &b, bn) - 1.0).abs() < 1e-6);
        assert!(cosine_with_norm(&a, &c, l2_norm(&c)).abs() < 1e-6);
        assert!((cosine_with_norm(&a, &d, l2_norm(&d)) + 1.0).abs() < 1e-6);
        // 零向量与维度不齐 → 0，不 panic
        assert_eq!(cosine_with_norm(&a, &[0.0, 0.0], 0.0), 0.0);
        assert_eq!(cosine_with_norm(&a, &[1.0], 1.0), 0.0);
        // ⚠ Red Check 教训（2026-10-24）：全部用单位向量时，去掉 sqrt 的破坏
        // 不会改变结果（单位向量 norm² == norm）。必须有非单位向量锚定归一化：
        // [2,0] vs [1,0] 的余弦恒为 1（尺度无关）；若 norm 实现错了（平方不开方），
        // 结果 = 2·dot/(|a|²|b|²) = 0.25 → 本断言失败。
        let scaled = vec![2.0, 0.0];
        assert!((cosine_with_norm(&scaled, &b, l2_norm(&b)) - 1.0).abs() < 1e-6);
        let half = vec![0.5, 0.5];
        assert!((cosine_with_norm(&half, &half, l2_norm(&half)) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn f32_le_blob_roundtrip() {
        let v = vec![0.25f32, -3.5, 1e-8, f32::MAX];
        let bytes = f32_vec_to_le_bytes(&v);
        assert_eq!(bytes.len(), 16);
        let back = le_bytes_to_f32_vec(&bytes);
        assert_eq!(v, back);
        // 非 4 倍数长度按 chunks_exact 截尾，不 panic
        assert_eq!(le_bytes_to_f32_vec(&bytes[..13]).len(), 3);
    }

    #[test]
    fn upsert_get_chunks_roundtrip_and_replace() {
        let store = test_store();
        let v1 = vec![1.0f32, 0.0, 0.0];
        let v2 = vec![0.0f32, 1.0, 0.0];
        let meta = store
            .upsert_source(upsert_args("note:a", "note", "m1", &[v1.clone(), v2.clone()]))
            .expect("upsert");
        assert_eq!(meta.chunk_count, 2);
        assert_eq!(meta.model_id, "m1");
        assert_eq!(meta.dims, Some(3));

        let chunks = store.get_chunks("note:a").expect("get chunks");
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].content, "chunk-0 of note:a");
        assert_eq!(chunks[0].embedding, v1);

        // 同源重传 → 整源替换（不重复）
        let meta2 = store
            .upsert_source(upsert_args("note:a", "note", "m1", &[v2.clone()]))
            .expect("re-upsert");
        assert_eq!(meta2.chunk_count, 1);
        assert_eq!(store.get_chunks("note:a").expect("chunks").len(), 1);
    }

    #[test]
    fn search_ranks_by_cosine_and_filters_type() {
        let store = test_store();
        let va = vec![1.0f32, 0.0, 0.0];
        let vb = vec![0.6f32, 0.8, 0.0];
        let vc = vec![0.0f32, 1.0, 0.0];
        store
            .upsert_source(upsert_args("note:a", "note", "m", &[va.clone()]))
            .expect("upsert a");
        store
            .upsert_source(upsert_args("import:b", "import", "m", &[vb.clone()]))
            .expect("upsert b");
        store
            .upsert_source(upsert_args("note:c", "note", "m", &[vc.clone()]))
            .expect("upsert c");

        let hits = store
            .search(KnowledgeSearchArgs {
                query_embedding: va.clone(),
                top_k: Some(2),
                source_type: None,
            })
            .expect("search all");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].source_id, "note:a");
        assert!((hits[0].score - 1.0).abs() < 1e-6);
        assert_eq!(hits[1].source_id, "import:b");

        let filtered = store
            .search(KnowledgeSearchArgs {
                query_embedding: va.clone(),
                top_k: None, // 默认 5
                source_type: Some("import".to_string()),
            })
            .expect("search import only");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].source_id, "import:b");
    }

    #[test]
    fn search_empty_index_returns_empty() {
        let store = test_store();
        let hits = store
            .search(KnowledgeSearchArgs {
                query_embedding: vec![1.0, 0.0],
                top_k: None,
                source_type: None,
            })
            .expect("empty search");
        assert!(hits.is_empty());
    }

    #[test]
    fn dims_mismatch_fails_loudly() {
        let store = test_store();
        store
            .upsert_source(upsert_args("note:a", "note", "m", &[vec![1.0, 0.0, 0.0]]))
            .expect("upsert");
        let err = store
            .search(KnowledgeSearchArgs {
                query_embedding: vec![1.0, 0.0],
                top_k: None,
                source_type: None,
            })
            .expect_err("dims mismatch must fail");
        assert!(err.contains("维度"), "实际错误：{err}");
    }

    #[test]
    fn model_change_requires_clear() {
        let store = test_store();
        store
            .upsert_source(upsert_args("note:a", "note", "model-a", &[vec![1.0, 0.0]]))
            .expect("upsert a");
        let err = store
            .upsert_source(upsert_args("note:b", "note", "model-b", &[vec![0.0, 1.0]]))
            .expect_err("model change must fail");
        assert!(err.contains("embedding 模型已变更"), "实际错误：{err}");
        // 清空后可换模型
        store.clear_index().expect("clear");
        store
            .upsert_source(upsert_args("note:b", "note", "model-b", &[vec![0.0, 1.0]]))
            .expect("upsert after clear");
    }

    #[test]
    fn delete_source_cascades_chunks() {
        let store = test_store();
        store
            .upsert_source(upsert_args("note:a", "note", "m", &[vec![1.0, 0.0], vec![0.0, 1.0]]))
            .expect("upsert");
        store.delete_source("note:a").expect("delete");
        assert!(store.get_chunks("note:a").expect("chunks").is_empty());
        let stats = store.stats().expect("stats");
        assert_eq!(stats.chunk_count, 0);
        assert_eq!(stats.note_count, 0);
        // 删除后搜索应返回空（缓存已失效）
        let hits = store
            .search(KnowledgeSearchArgs {
                query_embedding: vec![1.0, 0.0],
                top_k: None,
                source_type: None,
            })
            .expect("search after delete");
        assert!(hits.is_empty());
    }

    #[test]
    fn error_status_source_stores_without_chunks() {
        let store = test_store();
        let mut args = upsert_args("note:bad", "note", "m", &[]);
        args.source.status = "error".to_string();
        args.source.error = Some("embed 失败原文".to_string());
        let meta = store.upsert_source(args).expect("upsert error source");
        assert_eq!(meta.status, "error");
        assert_eq!(meta.error.as_deref(), Some("embed 失败原文"));
        assert_eq!(meta.dims, None);
        let stats = store.stats().expect("stats");
        assert_eq!(stats.error_count, 1);
        assert_eq!(stats.chunk_count, 0);
    }

    #[test]
    fn stats_counts_sources_and_chunks() {
        let store = test_store();
        store
            .upsert_source(upsert_args("note:a", "note", "m", &[vec![1.0, 0.0]]))
            .expect("upsert a");
        store
            .upsert_source(upsert_args("import:b", "import", "m", &[vec![0.0, 1.0], vec![1.0, 1.0]]))
            .expect("upsert b");
        let stats = store.stats().expect("stats");
        assert_eq!(stats.note_count, 1);
        assert_eq!(stats.import_count, 1);
        assert_eq!(stats.chunk_count, 3);
        assert_eq!(stats.dims, Some(2));
        assert_eq!(stats.model_id, "m");
        assert!(stats.last_indexed_at.unwrap_or(0) > 0);
    }
}
