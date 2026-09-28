//! Tauri 命令包装层（移植自 LiveAgent commands/app/system.rs 的 skills 段与
//! MCP Hub 的 external_mcp 扫描入口）。全部为 `spawn_blocking` 包装的同步实现，
//! 错误如实上抛。注册点：lib.rs 的 `invoke_handler`。

use serde_json::Value;

use super::builtin::ensure_builtin_agent_skills_sync;
use super::external_mcp::{scan_external_mcp_servers, scan_mcp_config_file};
use super::library::{system_read_skill_metadata_sync, system_read_skill_text_sync};
use super::manager::system_manage_skill_sync;
use super::types::{
    SystemBuiltinSkillSeedResponse, SystemExternalMcpToolScan, SystemManageSkillResponse,
    SystemReadSkillMetadataResponse, SystemReadSkillTextResponse,
};

#[tauri::command]
pub async fn system_ensure_builtin_skills(
) -> Result<Vec<SystemBuiltinSkillSeedResponse>, String> {
    tauri::async_runtime::spawn_blocking(ensure_builtin_agent_skills_sync)
        .await
        .map_err(|e| format!("system_ensure_builtin_skills join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_manage_skill(payload: Value) -> Result<SystemManageSkillResponse, String> {
    tauri::async_runtime::spawn_blocking(move || system_manage_skill_sync(payload))
        .await
        .map_err(|e| format!("system_manage_skill join failed: {e}"))?
}

#[tauri::command]
pub async fn system_read_skill_text(
    path: String,
    offset: Option<usize>,
    length: Option<usize>,
) -> Result<SystemReadSkillTextResponse, String> {
    tauri::async_runtime::spawn_blocking(move || system_read_skill_text_sync(path, offset, length))
        .await
        .map_err(|e| format!("system_read_skill_text join failed: {e}"))?
}

#[tauri::command]
pub async fn system_read_skill_metadata(
    path: String,
) -> Result<SystemReadSkillMetadataResponse, String> {
    tauri::async_runtime::spawn_blocking(move || system_read_skill_metadata_sync(path))
        .await
        .map_err(|e| format!("system_read_skill_metadata join failed: {e}"))?
}

/// 扫描本机外部 AI 工具（claude-code / codex / claude-desktop / codebuddy）的
/// MCP Server 配置，供 MCP Hub「本地导入」复用。
#[tauri::command]
pub async fn mcp_scan_external() -> Result<Vec<SystemExternalMcpToolScan>, String> {
    Ok(tauri::async_runtime::spawn_blocking(scan_external_mcp_servers)
        .await
        .map_err(|e| format!("mcp_scan_external join failed: {e}"))?)
}

/// 解析用户手选的本地 MCP 配置文件（JSON：mcpServers / projects.*.mcpServers /
/// 裸 server map；TOML：[mcp_servers.*]）。
#[tauri::command]
pub async fn mcp_scan_config_file(path: String) -> Result<SystemExternalMcpToolScan, String> {
    tauri::async_runtime::spawn_blocking(move || scan_mcp_config_file(&path))
        .await
        .map_err(|e| format!("mcp_scan_config_file join failed: {e}"))?
}
