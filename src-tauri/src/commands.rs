//! commands.rs —— 自定义斜杠命令扫描（对齐 ZCode svc/commands 的命令文件模式）。
//!
//! 约定：`<工作区>/.ReinAgent/commands/*.md`，每个文件一条命令：
//! ```text
//! ---
//! name: review
//! description: 代码审查
//! ---
//! 请审查 $ARGUMENTS 的改动。
//! ```
//! frontmatter 的 `name` 缺省取文件名（去扩展名）；`description` 缺省为空。
//! 目录不存在返回空数组（不是错误——用户没建目录很正常）。

use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEntry {
    pub name: String,
    pub description: String,
    /// 模板正文（frontmatter 之后的全部内容，含 `$ARGUMENTS` 占位）
    pub body: String,
    /// 来源文件绝对路径（UI 展示/排错用）
    pub source: String,
}

/// 解析 frontmatter（`---` 包裹的 key: value）与正文。
fn parse_frontmatter(text: &str) -> (std::collections::BTreeMap<String, String>, String) {
    let mut meta = std::collections::BTreeMap::new();
    let trimmed = text.strip_prefix('\u{feff}').unwrap_or(text); // 容忍 BOM
    if let Some(rest) = trimmed.strip_prefix("---\n").or_else(|| trimmed.strip_prefix("---\r\n")) {
        if let Some(end) = rest.find("\n---") {
            let front = &rest[..end];
            let body = rest[end + 4..].trim_start_matches(['\n', '\r']).to_string();
            for line in front.lines() {
                if let Some((key, value)) = line.split_once(':') {
                    let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
                    meta.insert(key.trim().to_string(), value);
                }
            }
            return (meta, body);
        }
    }
    (meta, trimmed.to_string())
}

/// 扫描工作区的自定义命令目录。目录不存在 → 空数组（非错误）。
#[tauri::command]
pub async fn commands_scan(workspace_root: Option<String>) -> Result<Vec<CommandEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = match workspace_root {
            Some(r) if !r.trim().is_empty() => std::path::PathBuf::from(r.trim()),
            _ => return Ok(Vec::new()), // 无工作区：无自定义命令
        };
        let dir = root.join(".ReinAgent").join("commands");
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut out: Vec<CommandEntry> = Vec::new();
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| format!("读取命令目录失败 {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let is_md = path
                .extension()
                .map(|e| e.eq_ignore_ascii_case("md"))
                .unwrap_or(false);
            if !is_md {
                continue;
            }
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(e) => {
                    // 单文件读取失败不拖垮整体：如实记录到 description（No-Fallback）
                    eprintln!("[commands] 读取失败 {}: {e}", path.display());
                    continue;
                }
            };
            let (meta, body) = parse_frontmatter(&text);
            let fallback_name = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let name = meta
                .get("name")
                .cloned()
                .filter(|n| !n.trim().is_empty())
                .unwrap_or(fallback_name);
            if name.trim().is_empty() {
                continue;
            }
            out.push(CommandEntry {
                name: name.trim().to_string(),
                description: meta.get("description").cloned().unwrap_or_default(),
                body,
                source: path.display().to_string(),
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_ws(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "reinagent-commands-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn parse_frontmatter_extracts_meta_and_body() {
        let (meta, body) = parse_frontmatter("---\nname: review\ndescription: 代码审查\n---\n请审查 $ARGUMENTS。\n");
        assert_eq!(meta.get("name").map(String::as_str), Some("review"));
        assert_eq!(meta.get("description").map(String::as_str), Some("代码审查"));
        assert_eq!(body.trim(), "请审查 $ARGUMENTS。");
    }

    #[test]
    fn parse_frontmatter_without_header_returns_full_body() {
        let (meta, body) = parse_frontmatter("没有 frontmatter 的正文");
        assert!(meta.is_empty());
        assert_eq!(body, "没有 frontmatter 的正文");
    }

    #[test]
    fn scan_missing_dir_returns_empty_not_error() {
        let ws = tmp_ws("missing");
        fs::create_dir_all(&ws).unwrap();
        let result = tauri::async_runtime::block_on(commands_scan(Some(
            ws.display().to_string(),
        )))
        .unwrap();
        assert!(result.is_empty(), "目录不存在应为空数组而非报错");
    }

    #[test]
    fn scan_reads_commands_and_falls_back_to_filename() {
        let ws = tmp_ws("scan");
        let dir = ws.join(".ReinAgent").join("commands");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("review.md"),
            "---\nname: review\ndescription: 代码审查\n---\n审查 $ARGUMENTS。\n",
        )
        .unwrap();
        fs::write(dir.join("no-name.md"), "只有正文\n").unwrap();
        fs::write(dir.join("ignored.txt"), "not markdown\n").unwrap();

        let result = tauri::async_runtime::block_on(commands_scan(Some(
            ws.display().to_string(),
        )))
        .unwrap();
        assert_eq!(result.len(), 2, "只收 md 文件: {:?}", result.iter().map(|c| &c.name).collect::<Vec<_>>());
        let review = result.iter().find(|c| c.name == "review").unwrap();
        assert_eq!(review.description, "代码审查");
        assert!(review.body.contains("$ARGUMENTS"));
        let fallback = result.iter().find(|c| c.name == "no-name").unwrap();
        assert!(fallback.body.contains("只有正文"), "无 frontmatter 时正文应保留");
    }

    #[test]
    fn scan_without_workspace_returns_empty() {
        let result = tauri::async_runtime::block_on(commands_scan(None)).unwrap();
        assert!(result.is_empty());
    }
}
