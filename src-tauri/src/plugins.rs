//! plugins.rs —— 插件系统 v1（P2-G2）。
//!
//! 插件 = `~/.ReinAgent/plugins/<name>/` 目录 + `plugin.json` 清单：
//! ```json
//! {
//!   "name": "my-plugin",
//!   "description": "...",
//!   "version": "0.1.0",
//!   "commands": "commands",     // 可选：相对目录，扫 *.md（同工作区命令格式）
//!   "hooks": [                   // 可选：hook 条目（event/matcher/command/timeoutMs）
//!     { "event": "PreToolUse", "matcher": "exec_command", "command": "..." }
//!   ]
//! }
//! ```
//! 安装 = 从本地目录整拷到插件根（显式用户动作即视为信任来源）；
//! 贡献面挂接：commands → commands_scan 的 extra_dirs；hooks → TS hooksRuntime 合并。
//! 市场源（git/npm/github）与 agent/skill 贡献属后续批次。

use serde::Serialize;
use std::path::{Path, PathBuf};

const PLUGINS_ROOT_DIR: &str = "plugins";

fn plugins_root() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".ReinAgent").join(PLUGINS_ROOT_DIR)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    /// 插件根目录绝对路径
    pub root: String,
    pub name: String,
    pub description: String,
    pub version: String,
    /// commands 目录相对路径（manifest 声明且存在时）
    pub commands_dir: Option<String>,
    /// hooks 条目（manifest 原样）
    pub hooks: serde_json::Value,
    pub manifest_ok: bool,
}

fn read_manifest(root: &Path) -> Result<(String, String, String, Option<String>, serde_json::Value), String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Manifest {
        name: Option<String>,
        #[serde(default)]
        description: String,
        #[serde(default)]
        version: String,
        commands: Option<serde_json::Value>,
        #[serde(default)]
        hooks: serde_json::Value,
    }
    let text = std::fs::read_to_string(root.join("plugin.json"))
        .map_err(|e| format!("读取 plugin.json 失败：{e}"))?;
    let m: Manifest = serde_json::from_str(&text).map_err(|e| format!("plugin.json 解析失败：{e}"))?;
    let name = m
        .name
        .clone()
        .unwrap_or_else(|| root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
    // commands 声明：字符串（相对目录）
    let commands_dir = match m.commands {
        Some(serde_json::Value::String(rel)) => {
            let dir = root.join(&rel);
            if dir.is_dir() {
                Some(dir.display().to_string())
            } else {
                None
            }
        }
        _ => None,
    };
    Ok((name, m.description, m.version, commands_dir, m.hooks))
}

/// 列出已安装插件（目录存在但清单缺失的也返回，manifest_ok=false 如实标记）。
#[tauri::command]
pub async fn plugin_list() -> Result<Vec<InstalledPlugin>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = plugins_root();
        if !root.is_dir() {
            return Ok(Vec::new());
        }
        let mut out: Vec<InstalledPlugin> = Vec::new();
        let entries = std::fs::read_dir(&root).map_err(|e| format!("读取插件目录失败：{e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let (name, description, version, commands_dir, hooks) = match read_manifest(&path) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[plugins] {} skipped: {e}", path.display());
                    out.push(InstalledPlugin {
                        root: path.display().to_string(),
                        name: path
                            .file_name()
                            .map(|s| s.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        description: format!("清单缺失：{e}"),
                        version: String::new(),
                        commands_dir: None,
                        hooks: serde_json::Value::Null,
                        manifest_ok: false,
                    });
                    continue;
                }
            };
            out.push(InstalledPlugin {
                root: path.display().to_string(),
                name,
                description,
                version,
                commands_dir,
                hooks,
                manifest_ok: true,
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败 {}: {e}", dst.display()))?;
    let entries = std::fs::read_dir(src).map_err(|e| format!("读取源目录失败：{e}"))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("复制失败 {}: {e}", from.display()))?;
        }
    }
    Ok(())
}

/// 从本地目录安装插件（整拷到 `~/.ReinAgent/plugins/<name>`）。
#[tauri::command]
pub async fn plugin_install_from_dir(
    source: String,
    name: Option<String>,
    overwrite: Option<bool>,
) -> Result<InstalledPlugin, String> {
    let source_path = PathBuf::from(source.trim());
    if !source_path.is_dir() {
        return Err(format!("源目录不存在：{}", source_path.display()));
    }
    let plugin_name = name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            source_path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    if plugin_name.is_empty()
        || plugin_name
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || "-_.".contains(c)))
    {
        return Err(format!("非法插件名：{plugin_name}（仅限字母数字 - _ .）"));
    }
    let dst = plugins_root().join(&plugin_name);
    if dst.exists() && !overwrite.unwrap_or(false) {
        return Err(format!("插件 {plugin_name} 已存在（如需覆盖请开启覆盖安装）"));
    }
    // 清单必须在源目录里（不是插件的目录一律拒收）
    if !source_path.join("plugin.json").is_file() {
        return Err("源目录缺少 plugin.json 清单（不是有效插件）".to_string());
    }
    if dst.exists() {
        std::fs::remove_dir_all(&dst).map_err(|e| format!("清理旧插件目录失败：{e}"))?;
    }
    copy_dir_recursive(&source_path, &dst)?;
    let (name, description, version, commands_dir, hooks) = read_manifest(&dst)?;
    Ok(InstalledPlugin {
        root: dst.display().to_string(),
        name,
        description,
        version,
        commands_dir,
        hooks,
        manifest_ok: true,
    })
}

/// 卸载插件（删除其目录）。
#[tauri::command]
pub async fn plugin_uninstall(name: String) -> Result<(), String> {
    if name
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || "-_.".contains(c)))
    {
        return Err(format!("非法插件名：{name}"));
    }
    let dst = plugins_root().join(name.trim());
    if !dst.is_dir() {
        return Err(format!("插件不存在：{}", dst.display()));
    }
    std::fs::remove_dir_all(&dst).map_err(|e| format!("卸载失败：{e}"))
}
