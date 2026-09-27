//! 记忆（Memory）——对齐 LiveAgent memory 服务的一期子集：
//! - 存储：`~/.ReinAgent/memory/global/<type>/` 下的 markdown 文件
//!   （frontmatter: id/type/scope/created/updated/review；正文为记忆内容），
//!   索引启动时扫目录重建（不引入额外 SQLite，文件即真相）；
//! - 类型：user / feedback / project / reference（对齐 LiveAgent 五类去 daily）；
//! - 命令：`memory_list / memory_read / memory_write / memory_update /
//!   memory_delete`；`memory_index_overview` 供系统提示词注入；
//! - 注入（前端 runAgentTurn）：`# Memory Index` 段列出记忆条目摘要。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const MEMORY_TYPES: &[&str] = &["user", "feedback", "project", "reference"];
const MAX_BODY_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub memory_type: String,
    /// global | project（一期全部 global；project 维度二期）
    pub scope: String,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn memory_root() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    Path::new(&home).join(".ReinAgent").join("memory").join("global")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sanitize_id(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// frontmatter 解析（--- 包裹的 key: value 行 + 正文）
fn parse_memory_file(path: &Path, relative: &str) -> Option<MemoryEntry> {
    let text = fs::read_to_string(path).ok()?;
    let (meta, body) = match text.strip_prefix("---\n") {
        Some(rest) => {
            let end = rest.find("\n---")?;
            let front = &rest[..end];
            let body = rest[end + 4..].trim_start_matches('\n').to_string();
            (front, body)
        }
        None => ("", text),
    };
    let mut id = relative.to_string();
    let mut memory_type = "reference".to_string();
    let mut title = path.file_stem()?.to_string_lossy().to_string();
    let mut created_at = 0i64;
    let mut updated_at = 0i64;
    for line in meta.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches('"');
        match key.trim() {
            "id" => id = value.to_string(),
            "type" => memory_type = value.to_string(),
            "title" => title = value.to_string(),
            "created" => created_at = value.parse().unwrap_or(0),
            "updated" => updated_at = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    Some(MemoryEntry {
        id,
        memory_type,
        scope: "global".into(),
        title,
        body,
        created_at,
        updated_at,
    })
}

fn write_memory_file(entry: &MemoryEntry) -> Result<PathBuf, String> {
    let dir = memory_root().join(&entry.memory_type);
    fs::create_dir_all(&dir).map_err(|e| format!("创建记忆目录失败: {e}"))?;
    let file_name = format!("{}.md", sanitize_id(&entry.id));
    let path = dir.join(file_name);
    let content = format!(
        "---\nid: {}\ntype: {}\ntitle: \"{}\"\ncreated: {}\nupdated: {}\n---\n\n{}\n",
        entry.id, entry.memory_type, entry.title, entry.created_at, entry.updated_at, entry.body
    );
    fs::write(&path, content).map_err(|e| format!("写入记忆失败: {e}"))?;
    Ok(path)
}

fn scan_all() -> Vec<MemoryEntry> {
    let mut out = Vec::new();
    let root = memory_root();
    for memory_type in MEMORY_TYPES {
        let dir = root.join(memory_type);
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let relative = format!("{}/{}", memory_type, path.file_stem().unwrap_or_default().to_string_lossy());
            if let Some(parsed) = parse_memory_file(&path, &relative) {
                out.push(parsed);
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

/// 列出全部记忆（按更新时间倒序）。
#[tauri::command]
pub async fn memory_list() -> Result<Vec<MemoryEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(scan_all()))
        .await
        .map_err(|e| e.to_string())?
}

/// 读取单条记忆。
#[tauri::command]
pub async fn memory_read(id: String) -> Result<MemoryEntry, String> {
    let found = scan_all().into_iter().find(|e| e.id == id);
    found.ok_or_else(|| format!("记忆不存在: {id}"))
}

/// 写入（新建）。body 上限 8KB（对齐 LiveAgent）。
#[tauri::command]
pub async fn memory_write(entry: MemoryEntry) -> Result<MemoryEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if entry.body.len() > MAX_BODY_BYTES {
            return Err(format!("记忆内容超过上限（8KB）：{} 字节", entry.body.len()));
        }
        if !MEMORY_TYPES.contains(&entry.memory_type.as_str()) {
            return Err(format!("未知记忆类型: {}", entry.memory_type));
        }
        let mut entry = entry;
        entry.created_at = now_ms();
        entry.updated_at = entry.created_at;
        write_memory_file(&entry)?;
        Ok(entry)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 更新（标题/正文/类型）。
#[tauri::command]
pub async fn memory_update(id: String, title: String, body: String, memory_type: String) -> Result<MemoryEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if body.len() > MAX_BODY_BYTES {
            return Err(format!("记忆内容超过上限（8KB）：{} 字节", body.len()));
        }
        let mut existing = scan_all().into_iter().find(|e| e.id == id)
            .ok_or_else(|| format!("记忆不存在: {id}"))?;
        // 类型变化时删除旧文件
        if existing.memory_type != memory_type {
            let old = memory_root().join(&existing.memory_type)
                .join(format!("{}.md", sanitize_id(&existing.id)));
            let _ = fs::remove_file(old);
        }
        existing.title = title;
        existing.body = body;
        existing.memory_type = memory_type;
        existing.updated_at = now_ms();
        write_memory_file(&existing)?;
        Ok(existing)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除。
#[tauri::command]
pub async fn memory_delete(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let existing = scan_all().into_iter().find(|e| e.id == id)
            .ok_or_else(|| format!("记忆不存在: {id}"))?;
        let path = memory_root().join(&existing.memory_type)
            .join(format!("{}.md", sanitize_id(&existing.id)));
        fs::remove_file(path).map_err(|e| format!("删除失败: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 系统提示词注入段（对齐 LiveAgent `# Memory Index`）：每条一行摘要。
#[tauri::command]
pub async fn memory_index_overview() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let entries = scan_all();
        if entries.is_empty() {
            return Ok(String::new());
        }
        let mut lines = vec![
            "# Memory Index".to_string(),
            "Persistent memories about the user and their projects (managing tool not yet mounted; edit via the Memory page):".to_string(),
            String::new(),
        ];
        for entry in entries.iter().take(50) {
            let summary: String = entry.body.lines().take(2).collect::<Vec<_>>().join(" ");
            let summary = if summary.chars().count() > 160 {
                format!("{}…", summary.chars().take(160).collect::<String>())
            } else {
                summary
            };
            lines.push(format!(
                "- [{}] ({}) {}",
                entry.title, entry.memory_type, summary
            ));
        }
        Ok(lines.join("\n"))
    })
    .await
    .map_err(|e| e.to_string())?
}
