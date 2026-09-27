//! Skills —— 对齐 LiveAgent skills 服务的一期子集：
//! - 存储：`~/.ReinAgent/skills/<skill-name>/SKILL.md`（YAML frontmatter：
//!   name/description；正文为技能指令），与 Claude/LiveAgent 技能目录结构一致；
//! - 命令：`skills_list`（扫描目录解析元数据）/ `skills_read`（读全文）/
//!   `skills_save`（创建或更新）/ `skills_delete`；
//! - Agent 集成（前端 runAgentTurn）：启用技能注入系统提示词 `# Skills` 段
//!   （名称 + 描述 + 指引读取全文的说明，对齐 LiveAgent 的显式提及格式）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    /// 目录名（= 技能 id）
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub body: String,
}

fn skills_root() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    Path::new(&home).join(".ReinAgent").join("skills")
}

/// 启停状态存 `~/.ReinAgent/skills/.enabled.json`（id → bool；缺省 true）。
fn enabled_map_path() -> PathBuf {
    skills_root().join(".enabled.json")
}

fn load_enabled_map() -> std::collections::BTreeMap<String, bool> {
    let Ok(text) = fs::read_to_string(enabled_map_path()) else {
        return Default::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_enabled_map(map: &std::collections::BTreeMap<String, bool>) -> Result<(), String> {
    let path = enabled_map_path();
    fs::create_dir_all(path.parent().expect("root has parent"))
        .map_err(|e| format!("创建目录失败: {e}"))?;
    let text = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| format!("写入失败: {e}"))
}

/// 解析 SKILL.md：frontmatter（name/description）+ 正文。
fn parse_skill(dir: &Path, enabled_map: &std::collections::BTreeMap<String, bool>) -> Option<SkillEntry> {
    let id = dir.file_name()?.to_string_lossy().to_string();
    let text = fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let (front, body) = match text.strip_prefix("---\n") {
        Some(rest) => {
            let end = rest.find("\n---")?;
            (&rest[..end], rest[end + 4..].trim_start_matches('\n').to_string())
        }
        None => ("", text),
    };
    let mut name = id.clone();
    let mut description = String::new();
    for line in front.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches('"');
        match key.trim() {
            "name" => name = value.to_string(),
            "description" => description = value.to_string(),
            _ => {}
        }
    }
    let enabled = enabled_map.get(&id).copied().unwrap_or(true);
    Some(SkillEntry { id, name, description, enabled, body })
}

fn scan_all() -> Vec<SkillEntry> {
    let enabled = load_enabled_map();
    let root = skills_root();
    let Ok(entries) = fs::read_dir(&root) else { return Vec::new() };
    let mut out: Vec<SkillEntry> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.join("SKILL.md").exists())
        .filter_map(|d| parse_skill(&d, &enabled))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// 列出全部技能（含禁用）。
#[tauri::command]
pub async fn skills_list() -> Result<Vec<SkillEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(scan_all()))
        .await
        .map_err(|e| e.to_string())?
}

/// 读单个技能全文。
#[tauri::command]
pub async fn skills_read(id: String) -> Result<SkillEntry, String> {
    let found = scan_all().into_iter().find(|s| s.id == id);
    found.ok_or_else(|| format!("技能不存在: {id}"))
}

/// 创建或更新技能（写 SKILL.md；id = 目录名，消毒后落盘）。
#[tauri::command]
pub async fn skills_save(entry: SkillEntry) -> Result<SkillEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let safe_id: String = entry
            .id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect();
        if safe_id.is_empty() || safe_id.starts_with('.') {
            return Err("技能 id 非法（不能为空或以 . 开头）".into());
        }
        let dir = skills_root().join(&safe_id);
        fs::create_dir_all(&dir).map_err(|e| format!("创建技能目录失败: {e}"))?;
        let content = format!(
            "---\nname: \"{}\"\ndescription: \"{}\"\n---\n\n{}\n",
            entry.name, entry.description, entry.body
        );
        fs::write(dir.join("SKILL.md"), content)
            .map_err(|e| format!("写入 SKILL.md 失败: {e}"))?;
        // 启停状态落图
        let mut map = load_enabled_map();
        map.insert(safe_id.clone(), entry.enabled);
        save_enabled_map(&map)?;
        Ok(SkillEntry { id: safe_id, ..entry })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除技能（整个目录）。
#[tauri::command]
pub async fn skills_delete(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 防御性校验：id 仅允许安全字符，拒绝路径穿越
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(format!("技能 id 非法: {id}"));
        }
        let dir = skills_root().join(&id);
        if dir.exists() {
            fs::remove_dir_all(dir).map_err(|e| format!("删除失败: {e}"))?;
        }
        let mut map = load_enabled_map();
        map.remove(&id);
        save_enabled_map(&map)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 启停切换（只写 enabled.json）。
#[tauri::command]
pub async fn skills_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut map = load_enabled_map();
        map.insert(id, enabled);
        save_enabled_map(&map)
    })
    .await
    .map_err(|e| e.to_string())?
}
