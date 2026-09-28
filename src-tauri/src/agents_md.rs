//! agents_md.rs —— 工作区 AGENTS.md / CLAUDE.md 读取（对齐 ZCode request-user-context）。
//!
//! 查找顺序（对齐 ZCode/LiveAgent 惯例，先近后远、先专用后通用）：
//! 1. `<工作区>/AGENTS.md`
//! 2. `<工作区>/.agents/AGENTS.md`
//! 3. `<工作区>/CLAUDE.md`
//! 4. `<工作区>/.claude/CLAUDE.md`
//!
//! 返回命中文件的路径与全文（找不到返回空数组——不是错误）。单文件 64KB 上限
//! （超限截断并标注）；只读文本，不解析内容。

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsMdFile {
    /// 语义来源（AGENTS.md / CLAUDE.md 等，注入时的展示名）
    pub source: String,
    /// 文件绝对路径
    pub path: String,
    /// 内容（64KB 上限，超限截断并标注）
    pub content: String,
    pub truncated: bool,
}

const AGENTS_MD_MAX_BYTES: usize = 64 * 1024;

const CANDIDATES: &[(&str, &str)] = &[
    ("AGENTS.md", "AGENTS.md"),
    (".agents/AGENTS.md", "AGENTS.md"),
    ("CLAUDE.md", "CLAUDE.md"),
    (".claude/CLAUDE.md", "CLAUDE.md"),
];

#[tauri::command]
pub async fn agents_md_read(workspace_root: Option<String>) -> Result<Vec<AgentsMdFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let root = match workspace_root {
            Some(r) if !r.trim().is_empty() => std::path::PathBuf::from(r.trim()),
            _ => return Ok(out), // 无工作区：无注入
        };
        for (file_name, source_label) in CANDIDATES {
            let path = root.join(file_name);
            let text = match std::fs::read(&path) {
                Ok(bytes) => {
                    if bytes.len() > AGENTS_MD_MAX_BYTES * 2 {
                        // 双倍上限的原始文件直接跳过（异常大的指令文件不注入）
                        eprintln!("[agents-md] 跳过超大文件: {}", path.display());
                        continue;
                    }
                    String::from_utf8_lossy(&bytes).to_string()
                }
                Err(_) => continue, // 不存在/不可读：跳过该候选（非错误）
            };
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            let truncated = text.len() > AGENTS_MD_MAX_BYTES;
            let content = if truncated {
                let mut cut = text;
                cut.truncate(AGENTS_MD_MAX_BYTES);
                format!("{cut}\n…[truncated: 指令文件超过 64KB，仅注入前 64KB]")
            } else {
                text
            };
            out.push(AgentsMdFile {
                source: source_label.to_string(),
                path: path.display().to_string(),
                content,
                truncated,
            });
            break; // 只取最优先命中的一个（AGENTS.md 优先于 CLAUDE.md）
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
