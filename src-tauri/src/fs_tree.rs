//! 工作区文件树（P2-D1）：懒加载目录树的后端命令。
//! `fs_tree_dir`：单层目录列出（名称 + is_dir + 大小），前端点击目录时逐层展开。

use serde::Serialize;
use std::fs;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    pub is_dir: bool,
    /// 文件字节数（目录为 0）
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeDirResponse {
    pub path: String,
    pub entries: Vec<TreeEntry>,
}

/// 列出单层目录（按「目录优先 + 名称」排序；跳过无法读取的项）。
#[tauri::command]
pub async fn fs_tree_dir(path: String) -> Result<TreeDirResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries: Vec<TreeEntry> = Vec::new();
        let read = fs::read_dir(&path).map_err(|e| format!("fs_tree_dir: {e}"))?;
        for entry in read.flatten() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            entries.push(TreeEntry {
                name,
                is_dir: metadata.is_dir(),
                size: metadata.len(),
            });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(TreeDirResponse {
            path,
            entries,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
