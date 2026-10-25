//! 笔记元数据（ROADMAP ④ 笔记增强包）：独立 SQLite 库承载三件派生数据——
//! 版本历史 / 标签 / 回收站登记。`.md` 文件本身零污染（Obsidian/Typora 互通
//! 卖点不受影响；用户拍板 2026-10-25：标签走 SQLite，不写 frontmatter）。
//!
//! 库：`~/.ReinAgent/notes-meta.sqlite3`（照 knowledge_index 先例：幂等 DDL、
//! WAL、integrity_check 损坏隔离重建）。派生数据**不进 WebDAV 备份**。
//!
//! - 版本历史：notes_fs::notes_save_note 在内容有变时快照旧内容（source 区分
//!   autosave/ai/manual/restore）；每笔记保留最近 20 版；还原前先把当前内容
//!   存为新快照（回滚本身不丢数据）。
//! - 标签：note_tags 多对多；note_id=`{notebookRel}:{fileName}`；带
//!   mtime:size 指纹列（外部改名/移动后读取时可对账清理孤儿，knowledge 先例）。
//! - 回收站：删除 = fs::rename 进 notebooks/.trash/ + 本表登记（原位置、时间、
//!   是否笔记本删除）；30 天启动清扫（文件+行）。

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const KEEP_VERSIONS_PER_NOTE: usize = 20;
const TRASH_RETENTION_DAYS: i64 = 30;

const NOTES_META_DDL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS note_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id      TEXT    NOT NULL,
    notebook_rel TEXT    NOT NULL,
    file_name    TEXT    NOT NULL,
    content      TEXT    NOT NULL,
    source       TEXT    NOT NULL DEFAULT 'autosave',
    saved_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS note_tags (
    note_id      TEXT NOT NULL,
    tag          TEXT NOT NULL,
    notebook_rel TEXT NOT NULL DEFAULT '',
    file_name    TEXT NOT NULL DEFAULT '',
    fingerprint  TEXT NOT NULL DEFAULT '',
    updated_at   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag);

CREATE TABLE IF NOT EXISTS note_trash (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    original_notebook_rel TEXT    NOT NULL,
    original_file_name    TEXT    NOT NULL,
    trash_file_name       TEXT    NOT NULL,
    was_notebook          INTEGER NOT NULL DEFAULT 0,
    deleted_at            INTEGER NOT NULL
);
"#;

// ==================== DTO ====================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteVersionRow {
    pub id: i64,
    pub note_id: String,
    pub source: String,
    pub saved_at: i64,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteVersionContent {
    pub id: i64,
    pub note_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTagCount {
    pub tag: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTagsRow {
    pub note_id: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTrashRow {
    pub id: i64,
    pub original_notebook_rel: String,
    pub original_file_name: String,
    pub was_notebook: bool,
    pub deleted_at: i64,
    pub preview: String,
}

// ==================== Store =====================

pub struct NotesMetaStore {
    conn: Mutex<Connection>,
}

static NOTES_META: OnceLock<NotesMetaStore> = OnceLock::new();

pub fn store() -> &'static NotesMetaStore {
    NOTES_META.get_or_init(|| match NotesMetaStore::open() {
        Ok(store) => store,
        Err(error) => panic!("notes-meta store 初始化失败：{error}"),
    })
}

fn notes_meta_db_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法定位用户主目录".to_string())?;
    Ok(PathBuf::from(home).join(".ReinAgent").join("notes-meta.sqlite3"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn open_connection(db_path: &Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 notes-meta 目录失败：{e}"))?;
    }
    let conn = Connection::open(db_path).map_err(|e| format!("打开 notes-meta 失败：{e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置 busy_timeout 失败：{e}"))?;
    let check: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| format!("integrity_check 失败：{e}"))?;
    if check != "ok" {
        // 损坏隔离重建（派生数据，可重建语义：版本/回收站记录丢失但原文 .md 无损）
        let quarantine = db_path
            .parent()
            .ok_or("路径异常")?
            .join(".quarantine")
            .join(format!("corrupt-{}", now_ms()));
        fs::create_dir_all(&quarantine).map_err(|e| format!("创建隔离目录失败：{e}"))?;
        for suffix in ["", "-wal", "-shm"] {
            let from = PathBuf::from(format!("{}{suffix}", db_path.display()));
            if from.exists() {
                if let Some(name) = from.file_name() {
                    let _ = fs::rename(&from, quarantine.join(name));
                }
            }
        }
        drop(conn);
        let conn = Connection::open(db_path).map_err(|e| format!("重建 notes-meta 失败：{e}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("设置 busy_timeout 失败：{e}"))?;
        conn.execute_batch(NOTES_META_DDL)
            .map_err(|e| format!("重建 notes-meta 表失败：{e}"))?;
        return Ok(conn);
    }
    conn.execute_batch(NOTES_META_DDL)
        .map_err(|e| format!("初始化 notes-meta 表失败：{e}"))?;
    Ok(conn)
}

impl NotesMetaStore {
    pub fn open() -> Result<Self, String> {
        let conn = open_connection(&notes_meta_db_path()?)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn.lock().map_err(|e| format!("notes-meta 锁失败：{e}"))
    }

    // ---------------- 版本历史 ----------------

    /// 内容有变时快照旧内容（notes_save_note 的前置动作；source: autosave/ai/manual/restore）。
    pub fn snapshot_if_changed(
        &self,
        notebook_rel: &str,
        file_name: &str,
        new_content: &str,
        source: &str,
    ) -> Result<bool, String> {
        let note_id = format!("{notebook_rel}:{file_name}");
        let conn = self.lock()?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT content FROM note_versions WHERE note_id = ?1 ORDER BY saved_at DESC, id DESC LIMIT 1",
                [&note_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("读取最新快照失败：{e}"))?;
        // 快照基准：上一版快照 + 磁盘当前内容取「最近真相」——
        // 磁盘内容是最权威的（外部编辑器也改它），以磁盘为准。
        let disk_path = crate::notes_fs::get_notebooks_root()
            .join(notebook_rel)
            .join(file_name);
        let disk_content = fs::read_to_string(&disk_path).ok();
        // 快照基准 = 磁盘当前内容（最权威——外部编辑器也改它）；磁盘读不到时
        // 回退上一版快照（防御性，正常不会走到）。
        let Some(old) = disk_content.as_deref().or(existing.as_deref()) else {
            // 文件不存在（新建首存）或无任何旧内容 → 无可快照
            return Ok(false);
        };
        if old == new_content {
            return Ok(false); // 内容没变不产生版本（防抖尾巴/无编辑保存）
        }
        // 版本来源门禁（用户定稿 2026-10-25）：纯打字（autosave）不记版本——
        // 版本列表只留「有意识的安全点」（ai 改写/manual 手动存/restore 还原前留存）。
        // 磁盘安全不受影响（文件照写），只是 autosave 之间的中间态不占 20 版窗口。
        if source == "autosave" {
            return Ok(false);
        }
        let now = now_ms();
        conn.execute(
            "INSERT INTO note_versions (note_id, notebook_rel, file_name, content, source, saved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![note_id, notebook_rel, file_name, old, source, now],
        )
        .map_err(|e| format!("写入版本快照失败：{e}"))?;
        // 保留最近 N 版（同 note_id）
        conn.execute(
            "DELETE FROM note_versions WHERE note_id = ?1 AND id NOT IN (
                 SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY saved_at DESC, id DESC LIMIT ?2)",
            params![note_id, KEEP_VERSIONS_PER_NOTE as i64],
        )
        .map_err(|e| format!("裁剪版本失败：{e}"))?;
        Ok(true)
    }

    pub fn version_list(&self, note_id: &str) -> Result<Vec<NoteVersionRow>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, note_id, source, saved_at, substr(content, 1, 200) FROM note_versions
                 WHERE note_id = ?1 ORDER BY saved_at DESC, id DESC",
            )
            .map_err(|e| format!("列出版本失败：{e}"))?;
        let mapped = stmt
            .query_map([note_id], |row| {
                Ok(NoteVersionRow {
                    id: row.get(0)?,
                    note_id: row.get(1)?,
                    source: row.get(2)?,
                    saved_at: row.get(3)?,
                    preview: row.get::<_, String>(4)?.trim().to_string(),
                })
            })
            .map_err(|e| format!("列出版本失败：{e}"))?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row.map_err(|e| format!("读取版本行失败：{e}"))?);
        }
        Ok(out)
    }

    /// 取版本全文（还原用；还原动作本身由前端走 notes_save_note → 自动产生 restore 快照）。
    pub fn version_content(&self, version_id: i64) -> Result<NoteVersionContent, String> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT id, note_id, content FROM note_versions WHERE id = ?1",
            [version_id],
            |row| {
                Ok(NoteVersionContent {
                    id: row.get(0)?,
                    note_id: row.get(1)?,
                    content: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("读取版本失败：{e}"))?
        .ok_or_else(|| format!("版本不存在：{version_id}"))
    }

    // ---------------- 标签 ----------------

    pub fn set_tags(
        &self,
        notebook_rel: &str,
        file_name: &str,
        tags: &[String],
        fingerprint: &str,
    ) -> Result<(), String> {
        let note_id = format!("{notebook_rel}:{file_name}");
        let cleaned: Vec<String> = {
            let mut seen = std::collections::BTreeSet::new();
            tags.iter()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty() && t.len() <= 40)
                .filter(|t| seen.insert(t.clone()))
                .collect()
        };
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(|e| format!("开启标签事务失败：{e}"))?;
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", [&note_id])
            .map_err(|e| format!("清标签失败：{e}"))?;
        let now = now_ms();
        for tag in &cleaned {
            tx.execute(
                "INSERT OR IGNORE INTO note_tags (note_id, tag, notebook_rel, file_name, fingerprint, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![note_id, tag, notebook_rel, file_name, fingerprint, now],
            )
            .map_err(|e| format!("写标签失败：{e}"))?;
        }
        tx.commit().map_err(|e| format!("提交标签失败：{e}"))?;
        Ok(())
    }

    pub fn all_tags(&self) -> Result<Vec<NoteTagsRow>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT note_id, tag FROM note_tags ORDER BY note_id, tag")
            .map_err(|e| format!("读取标签失败：{e}"))?;
        let mapped = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| format!("读取标签失败：{e}"))?;
        let mut by_note: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for row in mapped {
            let (note_id, tag) = row.map_err(|e| format!("读取标签行失败：{e}"))?;
            by_note.entry(note_id).or_default().push(tag);
        }
        Ok(by_note
            .into_iter()
            .map(|(note_id, tags)| NoteTagsRow { note_id, tags })
            .collect())
    }

    pub fn tag_counts(&self) -> Result<Vec<NoteTagCount>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT tag, COUNT(*) FROM note_tags GROUP BY tag ORDER BY tag")
            .map_err(|e| format!("统计标签失败：{e}"))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok(NoteTagCount { tag: row.get(0)?, count: row.get(1)? })
            })
            .map_err(|e| format!("统计标签失败：{e}"))?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row.map_err(|e| format!("统计标签行失败：{e}"))?);
        }
        Ok(out)
    }

    /// 重命名时迁移 note_id（版本/标签同事务）。
    pub fn migrate_note_id(
        &self,
        notebook_rel: &str,
        old_file_name: &str,
        new_file_name: &str,
    ) -> Result<(), String> {
        let old_id = format!("{notebook_rel}:{old_file_name}");
        let new_id = format!("{notebook_rel}:{new_file_name}");
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(|e| format!("开启迁移事务失败：{e}"))?;
        tx.execute(
            "UPDATE note_versions SET note_id = ?2, file_name = ?3 WHERE note_id = ?1",
            params![old_id, new_id, new_file_name],
        )
        .map_err(|e| format!("迁移版本 note_id 失败：{e}"))?;
        tx.execute(
            "UPDATE note_tags SET note_id = ?2, file_name = ?3 WHERE note_id = ?1",
            params![old_id, new_id, new_file_name],
        )
        .map_err(|e| format!("迁移标签 note_id 失败：{e}"))?;
        tx.commit().map_err(|e| format!("提交迁移失败：{e}"))?;
        Ok(())
    }

    /// 标签孤儿对账：note_tags 指向的文件已不存在（外部改名/移动）→ 删除该行。
    /// 返回清理的行数（v1 读取时清理，不做监听）。
    pub fn prune_orphan_tags(&self) -> Result<usize, String> {
        let root = crate::notes_fs::get_notebooks_root();
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT note_id, notebook_rel, file_name FROM note_tags")
            .map_err(|e| format!("对账标签失败：{e}"))?;
        let rows: Vec<(String, String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| format!("对账标签失败：{e}"))?
            .collect::<Result<_, _>>()
            .map_err(|e| format!("对账标签行失败：{e}"))?;
        drop(stmt);
        let mut removed = 0;
        for (note_id, notebook_rel, file_name) in rows {
            if !root.join(&notebook_rel).join(&file_name).exists() {
                removed += conn
                    .execute("DELETE FROM note_tags WHERE note_id = ?1", [&note_id])
                    .map_err(|e| format!("清理孤儿标签失败：{e}"))?;
            }
        }
        Ok(removed)
    }

    // ---------------- 回收站 ----------------

    /// 登记回收站（文件已被调用方 rename 进 .trash/）。
    pub fn trash_register(
        &self,
        original_notebook_rel: &str,
        original_file_name: &str,
        trash_file_name: &str,
        was_notebook: bool,
    ) -> Result<i64, String> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO note_trash (original_notebook_rel, original_file_name, trash_file_name, was_notebook, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                original_notebook_rel,
                original_file_name,
                trash_file_name,
                if was_notebook { 1 } else { 0 },
                now_ms()
            ],
        )
        .map_err(|e| format!("登记回收站失败：{e}"))?;
        Ok(conn.last_insert_rowid())
    }

    pub fn trash_list(&self) -> Result<Vec<NoteTrashRow>, String> {
        let conn = self.lock()?;
        let trash_dir = crate::notes_fs::get_notebooks_root().join(".trash");
        let mut stmt = conn
            .prepare(
                "SELECT id, original_notebook_rel, original_file_name, was_notebook, deleted_at, trash_file_name
                 FROM note_trash ORDER BY deleted_at DESC",
            )
            .map_err(|e| format!("列出回收站失败：{e}"))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| format!("列出回收站失败：{e}"))?;
        let mut out = Vec::new();
        for row in mapped {
            let (id, rel, name, was_nb, deleted_at, trash_name) =
                row.map_err(|e| format!("读取回收站行失败：{e}"))?;
            let preview = fs::read_to_string(trash_dir.join(&trash_name))
                .map(|c| c.trim().chars().take(200).collect::<String>())
                .unwrap_or_default();
            out.push(NoteTrashRow {
                id,
                original_notebook_rel: rel,
                original_file_name: name,
                was_notebook: was_nb != 0,
                deleted_at,
                preview,
            });
        }
        Ok(out)
    }

    /// 取回收站条目的原路径与 trash 文件名（restore/purge 共用）。
    pub fn trash_entry(&self, id: i64) -> Result<(String, String, String), String> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT original_notebook_rel, original_file_name, trash_file_name FROM note_trash WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("读取回收站条目失败：{e}"))?
        .ok_or_else(|| format!("回收站条目不存在：{id}"))
    }

    pub fn trash_remove_row(&self, id: i64) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM note_trash WHERE id = ?1", [id])
            .map_err(|e| format!("删除回收站行失败：{e}"))?;
        Ok(())
    }

    /// 30 天清扫：删过期文件 + 行（启动时调用一次）。
    pub fn trash_sweep_expired(&self) -> Result<usize, String> {
        let cutoff = now_ms() - TRASH_RETENTION_DAYS * 86_400_000;
        let trash_dir = crate::notes_fs::get_notebooks_root().join(".trash");
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT id, trash_file_name FROM note_trash WHERE deleted_at < ?1")
            .map_err(|e| format!("清扫查询失败：{e}"))?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([cutoff], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("清扫查询失败：{e}"))?
            .collect::<Result<_, _>>()
            .map_err(|e| format!("清扫行失败：{e}"))?;
        drop(stmt);
        let mut removed = 0;
        for (id, trash_name) in rows {
            let _ = fs::remove_file(trash_dir.join(&trash_name));
            conn.execute("DELETE FROM note_trash WHERE id = ?1", [id])
                .map_err(|e| format!("清扫删除失败：{e}"))?;
            removed += 1;
        }
        Ok(removed)
    }
}

// ==================== Tauri 命令 =====================

async fn meta_spawn_blocking<T, F>(command: &str, task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("{command} join 失败：{e}"))?
}

#[tauri::command]
pub async fn notes_version_list(note_id: String) -> Result<Vec<NoteVersionRow>, String> {
    meta_spawn_blocking("notes_version_list", move || store().version_list(&note_id)).await
}

#[tauri::command]
pub async fn notes_version_content(version_id: i64) -> Result<NoteVersionContent, String> {
    meta_spawn_blocking("notes_version_content", move || store().version_content(version_id)).await
}

#[tauri::command]
pub async fn notes_set_tags(
    notebook_rel_path: String,
    file_name: String,
    tags: Vec<String>,
) -> Result<(), String> {
    meta_spawn_blocking("notes_set_tags", move || {
        // 指纹 = 磁盘 mtime:size（对账锚点）
        let path = crate::notes_fs::get_notebooks_root()
            .join(&notebook_rel_path)
            .join(&file_name);
        let fingerprint = std::fs::metadata(&path)
            .ok()
            .map(|m| format!("{}:{}", m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0), m.len()))
            .unwrap_or_default();
        store().set_tags(&notebook_rel_path, &file_name, &tags, &fingerprint)
    })
    .await
}

#[tauri::command]
pub async fn notes_all_tags() -> Result<Vec<NoteTagsRow>, String> {
    meta_spawn_blocking("notes_all_tags", move || {
        let _ = store().prune_orphan_tags(); // 读取时对账（v1 不做监听）
        store().all_tags()
    })
    .await
}

#[tauri::command]
pub async fn notes_tag_counts() -> Result<Vec<NoteTagCount>, String> {
    meta_spawn_blocking("notes_tag_counts", move || store().tag_counts()).await
}

#[tauri::command]
pub async fn notes_trash_list() -> Result<Vec<NoteTrashRow>, String> {
    meta_spawn_blocking("notes_trash_list", move || store().trash_list()).await
}

#[tauri::command]
pub async fn notes_trash_restore(id: i64) -> Result<String, String> {
    meta_spawn_blocking("notes_trash_restore", move || {
        let (notebook_rel, file_name, trash_name) = store().trash_entry(id)?;
        let root = crate::notes_fs::get_notebooks_root();
        let trash_file = root.join(".trash").join(&trash_name);
        let dest_dir = root.join(&notebook_rel);
        fs::create_dir_all(&dest_dir).map_err(|e| format!("恢复建目录失败：{e}"))?;
        let mut dest = dest_dir.join(&file_name);
        if dest.exists() {
            // 原位被占：自动重名（fileStem (恢复于 yyyyMMdd-HHmmss).md）
            let stem = std::path::Path::new(&file_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("note");
            let ext = std::path::Path::new(&file_name)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("md");
            let ts = {
                use chrono::Local;
                Local::now().format("%Y%m%d-%H%M%S").to_string()
            };
            dest = dest_dir.join(format!("{stem} (恢复于 {ts}).{ext}"));
        }
        fs::rename(&trash_file, &dest).map_err(|e| format!("恢复文件失败：{e}"))?;
        store().trash_remove_row(id)?;
        Ok(dest.to_string_lossy().replace('\\', "/"))
    })
    .await
}

#[tauri::command]
pub async fn notes_trash_purge(id: i64) -> Result<(), String> {
    meta_spawn_blocking("notes_trash_purge", move || {
        let (_, _, trash_name) = store().trash_entry(id)?;
        let trash_file = crate::notes_fs::get_notebooks_root().join(".trash").join(&trash_name);
        let _ = fs::remove_file(&trash_file);
        store().trash_remove_row(id)?;
        Ok(())
    })
    .await
}

/// 启动清扫（30 天过期）+ 标签孤儿对账——lib.rs setup 调用一次。
pub fn startup_maintenance() {
    let _ = store().trash_sweep_expired();
    let _ = store().prune_orphan_tags();
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    /// env 全局锁：cargo 并行测试共享进程 env，HOME/USERPROFILE 互踩会让
    /// sandbox 形同虚设（本轮实测）。本组测试全程持锁串行。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 测试环境隔离：把 HOME/USERPROFILE 指到临时目录——get_notebooks_root()
    /// 与 notes-meta 库路径都走 env，不重定向会污染真实 ~/.ReinAgent（本轮实测踩中）。
    /// 铁律：笔记类测试必须先调本函数再碰任何文件。
    fn sandbox_home() -> tempfile::TempDir {
        let temp = tempfile::tempdir().expect("tempdir");
        // cargo 并行测试共享进程 env——本组测试用独立子目录避免互相干扰
        let home = temp.path().join("home");
        std::fs::create_dir_all(&home).expect("home dir");
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);
        temp
    }

    fn test_store() -> (tempfile::TempDir, NotesMetaStore) {
        let temp = sandbox_home();
        let db_path = notes_meta_db_path().expect("db path");
        let conn = open_connection(&db_path).expect("open");
        let store = NotesMetaStore { conn: Mutex::new(conn) };
        std::fs::create_dir_all(crate::notes_fs::get_notebooks_root()).expect("notebooks root");
        (temp, store)
    }

    fn write_disk(notebook_rel: &str, file_name: &str, content: &str) {
        let dir = crate::notes_fs::get_notebooks_root().join(notebook_rel);
        fs::create_dir_all(&dir).expect("mkdir");
        fs::write(dir.join(file_name), content).expect("write");
    }

    #[test]
    fn snapshot_only_on_change_and_cap_20() {
        let _env_guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (_sandbox, store) = test_store();
        write_disk("nb", "a.md", "v1");
        assert!(store.snapshot_if_changed("nb", "a.md", "v2", "manual").unwrap(), "内容有变应快照");
        // 模拟磁盘已是 v2 后再保存 v2（无变化）→ 不快照
        write_disk("nb", "a.md", "v2");
        assert!(!store.snapshot_if_changed("nb", "a.md", "v2", "manual").unwrap(), "无变化不得快照");
        // 连续 25 版 → 只留 20（manual 记版）
        for i in 3..=26 {
            write_disk("nb", "a.md", &format!("v{}", i - 1));
            store.snapshot_if_changed("nb", "a.md", &format!("v{i}"), "manual").unwrap();
        }
        let list = store.version_list("nb:a.md").unwrap();
        // 字面量断言（用常量会变同义反复——Red Check 实测踩中）
        assert_eq!(list.len(), 20, "保留最近 20 版");
        assert!(list[0].preview.contains("v25"), "最新快照应是 v25 旧内容，实际 {}", list[0].preview);
    }

    #[test]
    fn autosave_source_never_snapshots() {
        // 用户定稿 2026-10-25：纯打字（autosave）不记版本——版本只留有意识的安全点
        let _env_guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (_sandbox, store) = test_store();
        write_disk("nb", "auto.md", "draft-1");
        assert!(
            !store.snapshot_if_changed("nb", "auto.md", "draft-2", "autosave").unwrap(),
            "autosave 即使内容有变也不得记版"
        );
        assert!(store.version_list("nb:auto.md").unwrap().is_empty(), "autosave 不产生任何版本");
        // ai / restore 照常记版（Red Check 缝：去掉 source 门禁则本测试红）
        write_disk("nb", "auto.md", "draft-2");
        assert!(store.snapshot_if_changed("nb", "auto.md", "draft-3", "ai").unwrap(), "ai 应用应记版");
        write_disk("nb", "auto.md", "draft-3");
        assert!(store.snapshot_if_changed("nb", "auto.md", "draft-2", "restore").unwrap(), "还原前留存应记版");
        let list = store.version_list("nb:auto.md").unwrap();
        assert_eq!(list.len(), 2, "ai + restore 各一版（autosave 零版）");
    }

    #[test]
    fn tags_crud_and_rename_migration_and_orphan_prune() {
        let _env_guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (_sandbox, store) = test_store();
        write_disk("nb", "t.md", "# T");
        store.set_tags("nb", "t.md", &["rust".into(), "笔记".into(), "  ".into(), "rust".into()], "fp").unwrap();
        let all = store.all_tags().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].tags, vec!["rust".to_string(), "笔记".to_string()], "空串剔除+去重");
        let counts = store.tag_counts().unwrap();
        assert_eq!(counts.len(), 2);
        // rename 迁移
        store.migrate_note_id("nb", "t.md", "t2.md").unwrap();
        let all = store.all_tags().unwrap();
        assert_eq!(all[0].note_id, "nb:t2.md");
        // 孤儿清理：文件不存在 → 行删除
        fs::remove_file(crate::notes_fs::get_notebooks_root().join("nb").join("t.md")).unwrap();
        let removed = store.prune_orphan_tags().unwrap();
        assert_eq!(removed, 2, "两条 tag 行（rust+笔记）都应成孤儿");
        assert!(store.all_tags().unwrap().is_empty());
    }

    #[test]
    fn trash_register_list_and_sweep() {
        let _env_guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (_sandbox, store) = test_store();
        let id = store.trash_register("nb", "x.md", "x.123.md", false).unwrap();
        let list = store.trash_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].original_file_name, "x.md");
        assert_eq!(list[0].preview, "", "trash 文件不存在 preview 为空");
        // 清扫：手动把 deleted_at 拨到 31 天前
        {
            let conn = store.lock().unwrap();
            conn.execute(
                "UPDATE note_trash SET deleted_at = ?1 WHERE id = ?2",
                params![now_ms() - 31 * 86_400_000, id],
            )
            .unwrap();
        }
        let removed = store.trash_sweep_expired().unwrap();
        assert_eq!(removed, 1);
        assert!(store.trash_list().unwrap().is_empty());
    }

    #[test]
    fn version_content_roundtrip() {
        let _env_guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (_sandbox, store) = test_store();
        write_disk("nb", "r.md", "old-content");
        store.snapshot_if_changed("nb", "r.md", "new-content", "manual").unwrap();
        let list = store.version_list("nb:r.md").unwrap();
        let content = store.version_content(list[0].id).unwrap();
        assert_eq!(content.content, "old-content");
        assert_eq!(content.note_id, "nb:r.md");
        assert!(store.version_content(99999).is_err(), "不存在版本应报错");
    }
}
