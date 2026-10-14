//! 笔记与笔记本文件系统管理（~/.ReinAgent/notebooks）
//!
//! - 每个笔记本 = 物理文件夹（默认物理目录名为 default）
//! - 每篇笔记 = .md 文件
//! - 支持多级笔记本嵌套、增删改查与搜索

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// 获取笔记总根目录 ~/.ReinAgent/notebooks
pub fn get_notebooks_root() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".ReinAgent").join("notebooks")
    } else if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile).join(".ReinAgent").join("notebooks")
    } else {
        PathBuf::from("/tmp/ReinAgent/notebooks")
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NotebookFolder {
    pub id: String,
    pub name: String,
    pub relative_path: String,
    pub full_path: String,
    pub children: Vec<NotebookFolder>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteFileItem {
    pub id: String,
    pub title: String,
    pub file_name: String,
    pub notebook_rel_path: String,
    pub full_path: String,
    pub snippet: String,
    pub updated_at: u64,
    pub created_at: u64,
    pub size_bytes: u64,
}

/// 确保根目录及 default 默认笔记本存在
#[tauri::command]
pub async fn notes_ensure_root() -> Result<NotebookFolder, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = get_notebooks_root();
        let default_notebook = root.join("default");
        if !default_notebook.exists() {
            fs::create_dir_all(&default_notebook).map_err(|e| format!("创建笔记本默认目录失败: {e}"))?;
            // 如果刚创建，放置一篇默认欢迎笔记
            let welcome_file = default_notebook.join("welcome.md");
            if !welcome_file.exists() {
                let initial_text = "# Welcome to ReinAgent Notes\n\n- 这是你的默认笔记本。\n- 支持 Markdown 编辑、分栏与实时预览。\n- 每个笔记本都是一个文件夹，每篇笔记都是一个 `.md` 文档。\n";
                let _ = fs::write(&welcome_file, initial_text);
            }
        }
        build_folder_tree(&default_notebook, "default", &root)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn build_folder_tree(dir: &Path, rel: &str, root: &Path) -> Result<NotebookFolder, String> {
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(rel)
        .to_string();

    let mut children = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        let mut sub_dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir() && !p.file_name().and_then(|n| n.to_str()).unwrap_or("").starts_with('.'))
            .collect();
        sub_dirs.sort_by_key(|a| a.file_name().unwrap_or_default().to_os_string());
        for sub in sub_dirs {
            if let Ok(sub_rel) = sub.strip_prefix(root) {
                let sub_rel_str = sub_rel.to_string_lossy().replace('\\', "/");
                if let Ok(child_tree) = build_folder_tree(&sub, &sub_rel_str, root) {
                    children.push(child_tree);
                }
            }
        }
    }

    Ok(NotebookFolder {
        id: rel.to_string(),
        name,
        relative_path: rel.to_string(),
        full_path: dir.to_string_lossy().replace('\\', "/"),
        children,
    })
}

/// 列出所有笔记本树结构（以 root 为基准，包含 default 及同级/子级文件夹）
#[tauri::command]
pub async fn notes_list_notebooks() -> Result<Vec<NotebookFolder>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = get_notebooks_root();
        let default_notebook = root.join("default");
        if !default_notebook.exists() {
            let _ = fs::create_dir_all(&default_notebook);
        }

        let mut notebooks = Vec::new();
        if let Ok(entries) = fs::read_dir(&root) {
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir() && !p.file_name().and_then(|n| n.to_str()).unwrap_or("").starts_with('.'))
                .collect();
            // 排序：让 default 排在最前面，其余按字典序
            dirs.sort_by(|a, b| {
                let an = a.file_name().and_then(|s| s.to_str()).unwrap_or("");
                let bn = b.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if an == "default" {
                    std::cmp::Ordering::Less
                } else if bn == "default" {
                    std::cmp::Ordering::Greater
                } else {
                    an.to_lowercase().cmp(&bn.to_lowercase())
                }
            });

            for dir in dirs {
                if let Ok(rel) = dir.strip_prefix(&root) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    if let Ok(tree) = build_folder_tree(&dir, &rel_str, &root) {
                        notebooks.push(tree);
                    }
                }
            }
        }

        Ok(notebooks)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 创建新笔记本（文件夹）
#[tauri::command]
pub async fn notes_create_notebook(parent_rel_path: Option<String>, name: String) -> Result<NotebookFolder, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean_name = name.trim();
        if clean_name.is_empty() {
            return Err("笔记本名称不能为空".to_string());
        }
        if clean_name.contains('/') || clean_name.contains('\\') || clean_name.contains("..") {
            return Err("笔记本名称包含非法字符".to_string());
        }

        let root = get_notebooks_root();
        let target_dir = match parent_rel_path.filter(|p| !p.trim().is_empty()) {
            Some(rel) => root.join(rel).join(clean_name),
            None => root.join(clean_name),
        };

        if target_dir.exists() {
            return Err("该笔记本文件夹已存在".to_string());
        }
        fs::create_dir_all(&target_dir).map_err(|e| format!("创建笔记本失败: {e}"))?;

        let rel = target_dir.strip_prefix(&root).unwrap_or(&target_dir);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        build_folder_tree(&target_dir, &rel_str, &root)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 列出某个笔记本目录下的所有 md 笔记
#[tauri::command]
pub async fn notes_list_notes(notebook_rel_path: String) -> Result<Vec<NoteFileItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = get_notebooks_root();
        let target_dir = root.join(&notebook_rel_path);
        if !target_dir.exists() {
            return Ok(Vec::new());
        }

        let mut items = Vec::new();
        if let Ok(entries) = fs::read_dir(&target_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
                    if ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown") {
                        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
                        let title = path.file_stem().and_then(|s| s.to_str()).unwrap_or(&file_name).to_string();
                        let metadata = path.metadata().ok();
                        let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                        let updated_at = metadata.as_ref()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        let created_at = metadata.as_ref()
                            .and_then(|m| m.created().ok())
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(updated_at);

                        // 读取前 300 字符作为 snippet
                        let snippet = match fs::read_to_string(&path) {
                            Ok(text) => {
                                let trimmed = text.trim();
                                let first_part = trimmed.chars().take(200).collect::<String>();
                                first_part.replace('\n', " ")
                            }
                            Err(_) => String::new(),
                        };

                        let full_path = path.to_string_lossy().replace('\\', "/");
                        let id = format!("{}:{}", notebook_rel_path, file_name);

                        items.push(NoteFileItem {
                            id,
                            title,
                            file_name,
                            notebook_rel_path: notebook_rel_path.clone(),
                            full_path,
                            snippet,
                            updated_at,
                            created_at,
                            size_bytes,
                        });
                    }
                }
            }
        }

        // 默认按最后修改时间倒序排列
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(items)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取某篇笔记的文本内容
#[tauri::command]
pub async fn notes_read_note(notebook_rel_path: String, file_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = get_notebooks_root();
        let target_file = root.join(&notebook_rel_path).join(&file_name);
        if !target_file.exists() {
            return Err("笔记文件不存在".to_string());
        }
        fs::read_to_string(&target_file).map_err(|e| format!("读取笔记失败: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 保存/写入某篇笔记的内容
#[tauri::command]
pub async fn notes_save_note(
    notebook_rel_path: String,
    file_name: String,
    content: String,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = get_notebooks_root();
        let dir = root.join(&notebook_rel_path);
        if !dir.exists() {
            fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        let target_file = dir.join(&file_name);
        fs::write(&target_file, &content).map_err(|e| format!("保存笔记失败: {e}"))?;
        let now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(now)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 创建新笔记（自动分配文件名，如 Untitled.md，或按指定标题）
#[tauri::command]
pub async fn notes_create_note(
    notebook_rel_path: String,
    title: Option<String>,
) -> Result<NoteFileItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = get_notebooks_root();
        let dir = root.join(&notebook_rel_path);
        if !dir.exists() {
            fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
        }

        let base_title = title.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("Untitled");
        // 查找不重复的文件名
        let mut candidate_file_name = format!("{}.md", base_title);
        let mut counter = 1;
        while dir.join(&candidate_file_name).exists() {
            candidate_file_name = format!("{} {}.md", base_title, counter);
            counter += 1;
        }

        let target_file = dir.join(&candidate_file_name);
        let initial_content = format!("# {}\n\n", candidate_file_name.trim_end_matches(".md"));
        fs::write(&target_file, initial_content).map_err(|e| format!("新建笔记失败: {e}"))?;

        let now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let full_path = target_file.to_string_lossy().replace('\\', "/");
        let id = format!("{}:{}", notebook_rel_path, candidate_file_name);

        Ok(NoteFileItem {
            id,
            title: candidate_file_name.trim_end_matches(".md").to_string(),
            file_name: candidate_file_name,
            notebook_rel_path,
            full_path,
            snippet: String::new(),
            updated_at: now,
            created_at: now,
            size_bytes: 0,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 重命名笔记文件
#[tauri::command]
pub async fn notes_rename_note(
    notebook_rel_path: String,
    old_file_name: String,
    new_title: String,
) -> Result<NoteFileItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean_title = new_title.trim();
        if clean_title.is_empty() {
            return Err("笔记标题不能为空".to_string());
        }
        if clean_title.contains('/') || clean_title.contains('\\') {
            return Err("标题不能包含斜杠路径分隔符".to_string());
        }

        let root = get_notebooks_root();
        let dir = root.join(&notebook_rel_path);
        let old_file = dir.join(&old_file_name);
        if !old_file.exists() {
            return Err("原笔记文件不存在".to_string());
        }

        let new_file_name = if clean_title.to_lowercase().ends_with(".md") {
            clean_title.to_string()
        } else {
            format!("{}.md", clean_title)
        };

        let new_file = dir.join(&new_file_name);
        if new_file.exists() && new_file_name != old_file_name {
            return Err("同名笔记已存在".to_string());
        }

        if new_file_name != old_file_name {
            fs::rename(&old_file, &new_file).map_err(|e| format!("重命名失败: {e}"))?;
        }

        let now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let full_path = new_file.to_string_lossy().replace('\\', "/");
        let id = format!("{}:{}", notebook_rel_path, new_file_name);

        Ok(NoteFileItem {
            id,
            title: new_file_name.trim_end_matches(".md").to_string(),
            file_name: new_file_name,
            notebook_rel_path,
            full_path,
            snippet: String::new(),
            updated_at: now,
            created_at: now,
            size_bytes: 0,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除笔记
#[tauri::command]
pub async fn notes_delete_note(notebook_rel_path: String, file_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = get_notebooks_root();
        let file = root.join(&notebook_rel_path).join(&file_name);
        if file.exists() {
            fs::remove_file(&file).map_err(|e| format!("删除笔记失败: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除笔记本（文件夹）
#[tauri::command]
pub async fn notes_delete_notebook(notebook_rel_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = notebook_rel_path.trim().replace('\\', "/");
        if clean.is_empty() || clean == "default" {
            return Err("默认笔记本不允许删除".to_string());
        }
        let root = get_notebooks_root();
        let dir = root.join(&clean);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| format!("删除文件夹失败: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 重命名笔记本（文件夹）
#[tauri::command]
pub async fn notes_rename_notebook(notebook_rel_path: String, new_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = notebook_rel_path.trim().replace('\\', "/");
        if clean.is_empty() || clean == "default" {
            return Err("默认笔记本不允许重命名".to_string());
        }
        let clean_new = new_name.trim();
        if clean_new.is_empty() {
            return Err("新文件夹名称不能为空".to_string());
        }
        if clean_new.contains('/') || clean_new.contains('\\') || clean_new.contains("..") {
            return Err("文件夹名称包含非法字符".to_string());
        }
        let root = get_notebooks_root();
        let old_dir = root.join(&clean);
        if !old_dir.exists() {
            return Err("原文件夹不存在".to_string());
        }
        let parent = old_dir.parent().unwrap_or(&root);
        let new_dir = parent.join(clean_new);
        if new_dir.exists() && new_dir != old_dir {
            return Err("同名文件夹已存在".to_string());
        }
        fs::rename(&old_dir, &new_dir).map_err(|e| format!("重命名文件夹失败: {e}"))?;
        let new_rel = new_dir.strip_prefix(&root).unwrap_or(&new_dir);
        Ok(new_rel.to_string_lossy().replace('\\', "/"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 使用系统文件管理器打开笔记本文件夹
#[tauri::command]
pub async fn notes_open_folder(notebook_rel_path: String) -> Result<(), String> {
    let root = get_notebooks_root();
    let clean = notebook_rel_path.trim().replace('\\', "/");
    let target = if clean.is_empty() { root } else { root.join(&clean) };
    if !target.exists() {
        let _ = fs::create_dir_all(&target);
    }
    crate::fs_cmd::open_in_file_manager(Some(target.to_string_lossy().to_string())).await
}


