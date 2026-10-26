//! Wiki 项目文档生成（ROADMAP ⑨，Hetu WikiService 移植）。
//!
//! 存储于 knowledge.db（与 RAG / 图谱同域）：`wiki_documents`（套件内页面，
//! set_id 分组）+ `wiki_jobs`（生成任务即队列：先落库再执行，status/stage/progress）。
//! 执行器在前端 TS（LLM 全在 TS 侧，对齐看板/自动化的事件驱动模式）；
//! Rust 负责存储、上下文采集与陈旧任务回收。
//!
//! 知识投影：`knowledge_sources.source_type` 迁移放宽至 'wiki'（schema v2，
//! 重建表保数据），wiki 页以 `wiki:<doc_id>` 注册为知识库源参与 RAG 检索。

use crate::knowledge_index::store;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

// ===== 常量（对齐 Hetu WikiContextCollector / WikiService 实测值） =====

/// README/关键文档预算（字节）
const KEY_FILES_BUDGET: u64 = 48 * 1024;
/// 源码采样总预算（字节）
const SOURCE_BUDGET: u64 = 40 * 1024;
/// 源码采样文件数上限
const MAX_SOURCE_FILES: usize = 32;
/// 单采样文件读取上限（字节）
const SOURCE_FILE_LIMIT: u64 = 2400;
/// 目录树深度 / 条目上限
const MAX_TREE_DEPTH: usize = 3;
const MAX_TREE_ENTRIES: usize = 300;
/// 树扫描文件总数上限（防超大仓库）
const MAX_SCANNED_FILES: usize = 5000;
/// 运行中任务超过该时长无更新视为陈旧（前端 orchestrator 消失）
const STALE_RUNNING_MS: i64 = 10 * 60 * 1000;

/// 采集/采样忽略的目录名（Hetu RemoteIgnoredDirNames 精简）
const IGNORED_DIRS: [&str; 23] = [
    ".git", ".svn", ".hg", ".vs", ".idea", "node_modules", "bower_components", "vendor",
    "bin", "obj", "dist", "build", "out", "target", "coverage", ".next", ".nuxt",
    ".turbo", ".cache", ".parcel-cache", "venv", ".venv", "__pycache__",
];

const SOURCE_EXTS: [&str; 16] = [
    "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "cs", "c", "cpp", "h", "hpp",
    "rb", "php", "swift",
];

// ===== Schema =====

pub(crate) const WIKI_SCHEMA_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS wiki_documents (
    id          TEXT PRIMARY KEY,
    set_id      TEXT NOT NULL,
    workspace   TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL,
    chapter     TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL,
    brief       TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (set_id, sort_order)
);
CREATE INDEX IF NOT EXISTS idx_wiki_documents_set ON wiki_documents(set_id, sort_order);

CREATE TABLE IF NOT EXISTS wiki_jobs (
    id            TEXT PRIMARY KEY,
    workspace     TEXT NOT NULL DEFAULT '',
    status        INTEGER NOT NULL DEFAULT 0,
    stage         TEXT NOT NULL DEFAULT '',
    progress      INTEGER NOT NULL DEFAULT 0,
    total_pages   INTEGER,
    done_pages    INTEGER NOT NULL DEFAULT 0,
    set_id        TEXT,
    warning       TEXT,
    error         TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_jobs_updated ON wiki_jobs(updated_at DESC);
"#;

fn ensure_wiki_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(WIKI_SCHEMA_DDL)
        .map_err(|e| format!("wiki schema 初始化失败：{e}"))
}

/// knowledge_sources.source_type CHECK 放宽至 'wiki'（v2 迁移）：
/// 旧库按 sqlite_master 里的建表 SQL 判定，重建表拷贝数据；新库直接用新 DDL。
pub(crate) const KNOWLEDGE_SOURCES_DDL_V2: &str = r#"
CREATE TABLE knowledge_sources_new (
    source_id       TEXT PRIMARY KEY,
    source_type     TEXT    NOT NULL CHECK (source_type IN ('note', 'import', 'wiki')),
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
INSERT INTO knowledge_sources_new SELECT * FROM knowledge_sources;
DROP TABLE knowledge_sources;
ALTER TABLE knowledge_sources_new RENAME TO knowledge_sources;
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_type ON knowledge_sources(source_type, last_indexed_at DESC);
"#;

/// 幂等迁移：建表 SQL 不含 'wiki' 时执行重建（事务，失败回滚不留半态）。
pub fn migrate_knowledge_sources_v2(conn: &Connection) -> Result<bool, String> {
    let ddl: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_sources'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("读取 knowledge_sources 建表 SQL 失败：{e}"))?;
    if ddl.contains("'wiki'") {
        return Ok(false);
    }
    conn.execute_batch("BEGIN;")
        .map_err(|e| format!("开启迁移事务失败：{e}"))?;
    let result = KNOWLEDGE_SOURCES_DDL_V2
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .try_for_each(|stmt| conn.execute_batch(stmt).map_err(|e| format!("迁移语句失败：{e} — {stmt}")));
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT;").map_err(|e| format!("提交迁移失败：{e}"))?;
            Ok(true)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

// ===== DTO =====

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WikiDocumentMeta {
    pub id: String,
    pub set_id: String,
    pub sort_order: i64,
    pub chapter: String,
    pub title: String,
    pub brief: String,
    pub updated_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WikiDocumentFull {
    pub id: String,
    pub set_id: String,
    pub workspace: String,
    pub sort_order: i64,
    pub chapter: String,
    pub title: String,
    pub brief: String,
    pub content: String,
    pub updated_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WikiSetInfo {
    pub set_id: String,
    pub workspace: String,
    /// 总览页标题（sort_order = 0）
    pub title: String,
    pub page_count: i64,
    pub generated_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WikiJobDto {
    pub id: String,
    pub workspace: String,
    /// 0 排队 / 1 运行 / 2 完成 / 3 失败
    pub status: i32,
    pub stage: String,
    pub progress: i32,
    pub total_pages: Option<i64>,
    pub done_pages: i64,
    pub set_id: Option<String>,
    pub warning: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiJobUpdateArgs {
    pub id: String,
    #[serde(default)]
    pub status: Option<i32>,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub progress: Option<i32>,
    #[serde(default)]
    pub total_pages: Option<i64>,
    #[serde(default)]
    pub done_pages: Option<i64>,
    #[serde(default)]
    pub set_id: Option<String>,
    #[serde(default)]
    pub warning: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiWritePageArgs {
    /// 空 = 新建 id
    pub id: Option<String>,
    pub set_id: String,
    pub workspace: String,
    pub sort_order: i64,
    #[serde(default)]
    pub chapter: String,
    pub title: String,
    #[serde(default)]
    pub brief: String,
    pub content: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WikiContextMaterial {
    /// README / 关键文档拼接（≤48KB）
    pub base_context: String,
    /// 源码树文本（≤300 项）
    pub tree: String,
    /// 源码采样拼接（≤32 文件 / ≤40KB）
    pub sources: String,
    /// 顶层模块（按文件数排序的目录名；规划兜底大纲用）
    pub top_level_modules: Vec<String>,
    /// 采集失败原因（工作区不存在等）
    pub failure: Option<String>,
}

impl WikiContextMaterial {
    fn has_context(&self) -> bool {
        !self.base_context.trim().is_empty() || !self.sources.trim().is_empty()
    }
}

// ===== 上下文采集（Rust：文件遍历/读取是系统能力） =====

fn is_ignored_dir(name: &str) -> bool {
    IGNORED_DIRS.contains(&name) || name.starts_with('.')
}

fn read_capped(path: &Path, cap: u64) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > cap * 8 || meta.len() == 0 {
        return None; // 明显超大的文档不采（真实 README/文档极少超 384KB）
    }
    let bytes = std::fs::read(path).ok()?;
    let mut text = String::from_utf8_lossy(&bytes).to_string();
    if text.len() > cap as usize {
        let cut = text.floor_char_boundary(cap as usize);
        text.truncate(cut);
        text.push_str("\n…（截断）");
    }
    Some(text)
}

/// 采集工作区上下文：关键文档 + 源码树 + 源码采样（Hetu WikiContextCollector 同构）
pub fn wiki_collect_context_sync(workspace: &str) -> Result<WikiContextMaterial, String> {
    let mut material = WikiContextMaterial::default();
    let root = Path::new(workspace.trim());
    if !root.is_dir() {
        material.failure = Some(format!("工作区目录不存在：{workspace}"));
        return Ok(material);
    }

    // 1) 关键文档：README 优先，其次 docs/*.md（预算 48KB）
    let mut base = String::new();
    for candidate in ["README.md", "README.txt", "README", "Readme.md"] {
        let p = root.join(candidate);
        if p.is_file() {
            if let Some(text) = read_capped(&p, KEY_FILES_BUDGET) {
                base.push_str(&format!("# {candidate}\n\n{text}\n\n"));
            }
            break;
        }
    }
    let docs_dir = root.join("docs");
    if docs_dir.is_dir() && base.len() < KEY_FILES_BUDGET as usize {
        let mut md_files: Vec<_> = std::fs::read_dir(&docs_dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false))
            .map(|e| e.path())
            .collect();
        md_files.sort();
        for p in md_files {
            if base.len() >= KEY_FILES_BUDGET as usize {
                break;
            }
            if let Some(text) = read_capped(&p, 12 * 1024) {
                let name = p.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
                base.push_str(&format!("# docs/{name}\n\n{text}\n\n"));
            }
        }
    }
    if base.len() > KEY_FILES_BUDGET as usize {
        let cut = base.floor_char_boundary(KEY_FILES_BUDGET as usize);
        base.truncate(cut);
    }
    material.base_context = base.trim().to_string();

    // 2) 目录树（walkdir 深度 3，忽略规则，300 项）+ 顶层模块统计
    use std::collections::HashMap;
    let mut tree_lines: Vec<String> = Vec::new();
    let mut module_files: HashMap<String, u64> = HashMap::new();
    let mut source_candidates: Vec<std::path::PathBuf> = Vec::new();
    let mut scanned = 0usize;
    let walker = walkdir::WalkDir::new(root)
        .max_depth(MAX_TREE_DEPTH)
        .into_iter()
        .filter_entry(|e: &walkdir::DirEntry| {
            let name = e.file_name().to_string_lossy();
            // 隐藏目录 + 依赖/构建产物目录一并剪枝
            !(name.starts_with('.') || IGNORED_DIRS.contains(&name.as_ref()))
        });
    for entry in walker {
        let Ok(entry) = entry else { continue };
        scanned += 1;
        if scanned > MAX_SCANNED_FILES {
            break;
        }
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if rel.is_empty() {
            continue;
        }
        if entry.file_type().is_dir() {
            if tree_lines.len() < MAX_TREE_ENTRIES {
                tree_lines.push(format!("{}/", rel));
            }
            continue;
        }
        if tree_lines.len() < MAX_TREE_ENTRIES {
            tree_lines.push(rel.clone());
        }
        // 顶层模块统计（首段目录名；根文件归 "(root)"）
        let first = rel.split('/').next().unwrap_or("").to_string();
        let key = if rel.contains('/') { first } else { "(root)".to_string() };
        *module_files.entry(key).or_insert(0) += 1;
        // 源码采样候选
        if entry.depth() <= 4 {
            let ext_ok = entry
                .path()
                .extension()
                .map(|x| SOURCE_EXTS.contains(&x.to_string_lossy().as_ref()))
                .unwrap_or(false);
            if ext_ok {
                source_candidates.push(entry.path().to_path_buf());
            }
        }
    }
    material.tree = tree_lines.join("\n");
    let mut modules: Vec<(String, u64)> = module_files.into_iter().collect();
    modules.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    material.top_level_modules = modules.into_iter().map(|(k, _)| k).take(8).collect();

    // 3) 源码采样（32 文件 × 2400 字节，总 40KB；按路径排序保证确定性）
    source_candidates.sort();
    let mut sources = String::new();
    let mut used = 0u64;
    for path in source_candidates.iter().take(MAX_SOURCE_FILES * 3) {
        if used >= SOURCE_BUDGET || sources.len() >= SOURCE_BUDGET as usize {
            break;
        }
        let Some(text) = read_capped(path, SOURCE_FILE_LIMIT) else { continue };
        let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/");
        sources.push_str(&format!("--- {rel} ---\n{text}\n\n"));
        used += SOURCE_FILE_LIMIT.min(2400);
        if sources.matches("--- ").count() >= MAX_SOURCE_FILES {
            break;
        }
    }
    material.sources = sources.trim().to_string();
    Ok(material)
}

// ===== 存储逻辑（conn 参数化便于测试） =====

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!("{prefix}-{}-{:x}-{}", now_ms(), std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))
}

/// 陈旧回收：运行中但超过 10 分钟无更新的 job 标记失败（orchestrator 消失）
pub fn wiki_reap_stale_jobs_conn(conn: &Connection) -> Result<u64, String> {
    ensure_wiki_schema(conn)?;
    let cutoff = now_ms() - STALE_RUNNING_MS;
    let n = conn
        .execute(
            "UPDATE wiki_jobs SET status = 3, error = '生成中断（应用关闭或页面刷新）', updated_at = ?1
             WHERE status = 1 AND updated_at < ?2",
            params![now_ms(), cutoff],
        )
        .map_err(|e| e.to_string())?;
    Ok(n as u64)
}

fn job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WikiJobDto> {
    Ok(WikiJobDto {
        id: row.get(0)?,
        workspace: row.get(1)?,
        status: row.get(2)?,
        stage: row.get(3)?,
        progress: row.get(4)?,
        total_pages: row.get(5)?,
        done_pages: row.get(6)?,
        set_id: row.get(7)?,
        warning: row.get(8)?,
        error: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

pub fn wiki_job_create_conn(conn: &Connection, workspace: &str) -> Result<WikiJobDto, String> {
    ensure_wiki_schema(conn)?;
    let id = new_id("wjob");
    let now = now_ms();
    conn.execute(
        "INSERT INTO wiki_jobs (id, workspace, status, stage, progress, created_at, updated_at)
         VALUES (?1, ?2, 0, '排队中', 0, ?3, ?3)",
        params![id, workspace.trim(), now],
    )
    .map_err(|e| e.to_string())?;
    wiki_job_get_conn(conn, &id)?.ok_or_else(|| "任务创建后读取失败".to_string())
}

pub fn wiki_job_update_conn(conn: &Connection, args: WikiJobUpdateArgs) -> Result<(), String> {
    ensure_wiki_schema(conn)?;
    conn.execute(
        "UPDATE wiki_jobs SET
            status = COALESCE(?2, status),
            stage = COALESCE(?3, stage),
            progress = COALESCE(?4, progress),
            total_pages = COALESCE(?5, total_pages),
            done_pages = COALESCE(?6, done_pages),
            set_id = COALESCE(?7, set_id),
            warning = COALESCE(?8, warning),
            error = COALESCE(?9, error),
            updated_at = ?10
         WHERE id = ?1",
        params![
            args.id,
            args.status,
            args.stage,
            args.progress,
            args.total_pages,
            args.done_pages,
            args.set_id,
            args.warning,
            args.error,
            now_ms(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn wiki_job_get_conn(conn: &Connection, id: &str) -> Result<Option<WikiJobDto>, String> {
    ensure_wiki_schema(conn)?;
    conn.query_row(
        "SELECT id, workspace, status, stage, progress, total_pages, done_pages, set_id, warning, error, created_at, updated_at
         FROM wiki_jobs WHERE id = ?1",
        [id],
        job_from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn wiki_job_list_conn(conn: &Connection, limit: usize) -> Result<Vec<WikiJobDto>, String> {
    ensure_wiki_schema(conn)?;
    let _ = wiki_reap_stale_jobs_conn(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace, status, stage, progress, total_pages, done_pages, set_id, warning, error, created_at, updated_at
             FROM wiki_jobs ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit as i64], |r| job_from_row(r))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 写页面（同 set 同 sort_order 覆盖——单页重生成复用同一路径）
pub fn wiki_write_page_conn(conn: &Connection, args: WikiWritePageArgs) -> Result<String, String> {
    ensure_wiki_schema(conn)?;
    if args.title.trim().is_empty() {
        return Err("页面标题不能为空".into());
    }
    let id = match args.id.as_deref().filter(|s| !s.is_empty()) {
        Some(existing) => existing.to_string(),
        None => {
            conn.execute(
                "DELETE FROM wiki_documents WHERE set_id = ?1 AND sort_order = ?2",
                params![args.set_id, args.sort_order],
            )
            .map_err(|e| e.to_string())?;
            new_id("wdoc")
        }
    };
    let now = now_ms();
    conn.execute(
        "INSERT INTO wiki_documents (id, set_id, workspace, sort_order, chapter, title, brief, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
         ON CONFLICT(id) DO UPDATE SET
            chapter = excluded.chapter, title = excluded.title, brief = excluded.brief,
            content = excluded.content, updated_at = excluded.updated_at",
        params![id, args.set_id, args.workspace.trim(), args.sort_order, args.chapter.trim(), args.title.trim(), args.brief.trim(), args.content, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn wiki_delete_set_conn(conn: &Connection, set_id: &str) -> Result<u64, String> {
    ensure_wiki_schema(conn)?;
    let n = conn
        .execute("DELETE FROM wiki_documents WHERE set_id = ?1", [set_id])
        .map_err(|e| e.to_string())?;
    Ok(n as u64)
}

pub fn wiki_get_document_conn(conn: &Connection, id: &str) -> Result<Option<WikiDocumentFull>, String> {
    ensure_wiki_schema(conn)?;
    conn.query_row(
        "SELECT id, set_id, workspace, sort_order, chapter, title, brief, content, updated_at
         FROM wiki_documents WHERE id = ?1",
        [id],
        |r| {
            Ok(WikiDocumentFull {
                id: r.get(0)?,
                set_id: r.get(1)?,
                workspace: r.get(2)?,
                sort_order: r.get(3)?,
                chapter: r.get(4)?,
                title: r.get(5)?,
                brief: r.get(6)?,
                content: r.get(7)?,
                updated_at: r.get(8)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn wiki_documents_by_set_conn(conn: &Connection, set_id: &str) -> Result<Vec<WikiDocumentMeta>, String> {
    ensure_wiki_schema(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, set_id, sort_order, chapter, title, brief, updated_at
             FROM wiki_documents WHERE set_id = ?1 ORDER BY sort_order",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([set_id], |r| {
            Ok(WikiDocumentMeta {
                id: r.get(0)?,
                set_id: r.get(1)?,
                sort_order: r.get(2)?,
                chapter: r.get(3)?,
                title: r.get(4)?,
                brief: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn wiki_sets_list_conn(conn: &Connection) -> Result<Vec<WikiSetInfo>, String> {
    ensure_wiki_schema(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT d.set_id, MAX(d.workspace), COALESCE(o.title, MAX(d.title)), COUNT(*), MAX(d.updated_at)
             FROM wiki_documents d
             LEFT JOIN wiki_documents o ON o.set_id = d.set_id AND o.sort_order = 0
             GROUP BY d.set_id ORDER BY MAX(d.updated_at) DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(WikiSetInfo {
                set_id: r.get(0)?,
                workspace: r.get(1)?,
                title: r.get(2)?,
                page_count: r.get(3)?,
                generated_at: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// scan 投影：wiki 页 → 知识库源行（fingerprint = updated_at:内容长度，内容变更即触发重索引）
pub fn wiki_scan_sources_conn(conn: &Connection) -> Result<Vec<crate::knowledge_index::KnowledgeScanRow>, String> {
    ensure_wiki_schema(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, workspace, updated_at, LENGTH(content) FROM wiki_documents ORDER BY updated_at DESC LIMIT 500",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let id: String = r.get(0)?;
            let title: String = r.get(1)?;
            let workspace: String = r.get(2)?;
            let updated_at: i64 = r.get(3)?;
            let len: i64 = r.get(4)?;
            Ok(crate::knowledge_index::KnowledgeScanRow {
                source_id: format!("wiki:{id}"),
                source_type: "wiki".to_string(),
                title,
                source_path: workspace,
                fingerprint: format!("{updated_at}:{len}"),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

// ===== Tauri 命令 =====

#[tauri::command]
pub async fn wiki_collect_context(workspace: String) -> Result<WikiContextMaterial, String> {
    tauri::async_runtime::spawn_blocking(move || wiki_collect_context_sync(&workspace))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn wiki_job_create(workspace: String) -> Result<WikiJobDto, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    wiki_job_create_conn(&conn, &workspace)
}

#[tauri::command]
pub async fn wiki_job_update(args: WikiJobUpdateArgs) -> Result<(), String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    wiki_job_update_conn(&conn, args)
}

#[tauri::command]
pub async fn wiki_job_get(id: String) -> Result<Option<WikiJobDto>, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    wiki_job_get_conn(&conn, &id)
}

#[tauri::command]
pub async fn wiki_job_list(limit: Option<usize>) -> Result<Vec<WikiJobDto>, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    wiki_job_list_conn(&conn, limit.unwrap_or(20))
}

#[tauri::command]
pub async fn wiki_write_page(args: WikiWritePageArgs) -> Result<String, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    wiki_write_page_conn(&conn, args)
}

#[tauri::command]
pub async fn wiki_delete_set(set_id: String) -> Result<u64, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    wiki_delete_set_conn(&conn, &set_id)
}

#[tauri::command]
pub async fn wiki_get_document(id: String) -> Result<Option<WikiDocumentFull>, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    wiki_get_document_conn(&conn, &id)
}

#[tauri::command]
pub async fn wiki_documents_by_set(set_id: String) -> Result<Vec<WikiDocumentMeta>, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    wiki_documents_by_set_conn(&conn, &set_id)
}

#[tauri::command]
pub async fn wiki_sets_list() -> Result<Vec<WikiSetInfo>, String> {
    let store = store();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    wiki_sets_list_conn(&conn)
}
