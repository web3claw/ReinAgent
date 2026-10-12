//! 配置备份快照（LiveAgent `commands/config/settings/backup_snapshot.rs` 同构移植）：
//! 采集 / 校验 / 应用。
//!
//! 载体刻意选用「按域聚合的 JSON」而非整库或整目录打包 —— 不可信输入只过
//! serde 解析，不会把任意路径/SQL 交给执行层，大快照导入也不会冻结 UI。
//! 本模块搬运 ReinAgent 的五个配置域：
//!
//! - `providers`：`~/.ReinAgent/provider_config.json` 全量（含明文 API key，
//!   与 LiveAgent 同策略，manifest 的 `encryption` 字段预留后期加密）；
//! - `mcp`：`~/.ReinAgent/mcp_servers.json` 全量（`enabled` 字段即启用集）；
//! - `assistants`：`~/.ReinAgent/assistants/*.md` 文档打包成数组
//!   （文件名即 id；助手是用户手写的人设+绑定预设，丢了不可再生 —— 与技能
//!   本体不同，后者是内置种子/市场安装，可重装再生，故不进快照）；
//! - `skillsSelection`：kv `reinagent-skills-settings` 的 selected 启用清单
//!   （只备清单不备技能本体；目标机没有对应技能时注入自动忽略，无害）；
//! - `system`：`settings.json`（plugin-store）中 `settings` 键的白名单子集
//!   —— 默认模型指针（provider/modelId/baseUrl/apiKey）。stt 段与 UI 本地态
//!   是设备本地配置，不进快照。
//!
//! 导入侧的另一个关键步骤是 provider id 重映射：自定义供应商的 id 是各设备
//! 本地随机生成的（`custom-<时间戳>`），而快照内部的 system 默认模型指针与
//! 助手 frontmatter 的 `model: "providerId/modelId"` 绑定都引用它。整域覆盖前
//! 先按身份把备份 provider 映射回本机 id，引用才不会在导入后失配。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 载体格式版本。manifest 结构本身变更时递增。
pub const BACKUP_PROTOCOL_VERSION: u32 = 1;
/// 配置域 schema 版本。各域 payload 结构不兼容演进时递增。
pub const BACKUP_SCHEMA_VERSION: u32 = 1;

/// 导出文件中内联 manifest 的字段名。
const BACKUP_MANIFEST_FIELD: &str = "_manifest";
/// 本地备份保留份数。
const BACKUP_RETENTION: usize = 10;
const BACKUP_DIRNAME: &str = "backups";

/// system 域白名单：`settings.json` 的 `settings` 键里允许随快照流转的键。
/// 全部缺失时该域为 None。stt 段与未来加入的其它设备本地键不在白名单内。
const SYSTEM_PORTABLE_KEYS: &[&str] = &["provider", "apiKey", "modelId", "baseUrl"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub protocol_version: u32,
    pub schema_version: u32,
    pub snapshot_id: String,
    /// RFC3339 UTC 时间戳。
    pub created_at: String,
    pub device_name: String,
    pub app_version: String,
    /// 预留：首版恒为 "none"，后续引入端到端加密时改此字段而不破坏格式。
    #[serde(default = "default_backup_encryption")]
    pub encryption: String,
    /// 各域条目数，仅供 UI 展示摘要，不参与校验。
    #[serde(default)]
    pub domains: BackupDomainCounts,
}

fn default_backup_encryption() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDomainCounts {
    #[serde(default)]
    pub providers: usize,
    #[serde(default)]
    pub mcp: usize,
    #[serde(default)]
    pub assistants: usize,
    #[serde(default)]
    pub skills_selection: usize,
    #[serde(default)]
    pub system: usize,
}

/// 一份完整的配置快照。字段全部可选：某域为空表示导出侧没有该配置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshot {
    #[serde(default)]
    pub providers: Option<Value>,
    #[serde(default)]
    pub mcp: Option<Value>,
    /// 助手文档数组：[{ id, name, content }]（content = 完整 .md 文档）。
    #[serde(default)]
    pub assistants: Option<Value>,
    /// 技能启用清单（kv reinagent-skills-settings 的 selected 数组）。
    #[serde(default)]
    pub skills_selection: Option<Value>,
    /// settings.json `settings` 键的白名单子集。
    #[serde(default)]
    pub system: Option<Value>,
}

/// 导入/下载完成后的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupApplyOutcome {
    pub applied: BackupDomainCounts,
    /// 应用前生成的本地备份文件路径。
    pub backup_path: Option<String>,
}

fn config_dir() -> PathBuf {
    if let Ok(home) = std::env::var("USERPROFILE") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join(".ReinAgent");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join(".ReinAgent");
        }
    }
    PathBuf::from(".ReinAgent")
}

/// config_dir 的 crate 内公开形态（webdav_backup.rs 的同步配置落盘复用同一路径决议）。
pub(crate) fn config_dir_pub() -> PathBuf {
    config_dir()
}

fn backup_dir() -> Result<PathBuf, String> {
    let dir = config_dir().join(BACKUP_DIRNAME);
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
    Ok(dir)
}

fn backup_device_name() -> String {
    hostname_label().unwrap_or_else(|| "unknown-device".to_string())
}

fn hostname_label() -> Option<String> {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// manifest 的 `createdAt`：RFC3339 UTC，固定 `Z` 后缀。
fn rfc3339_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn count_domain(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(items)) => items.len(),
        Some(Value::Object(map)) => map.len(),
        _ => 0,
    }
}

fn count_mcp_servers(value: Option<&Value>) -> usize {
    value
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

pub fn snapshot_domain_counts(snapshot: &BackupSnapshot) -> BackupDomainCounts {
    BackupDomainCounts {
        providers: count_domain(snapshot.providers.as_ref()),
        mcp: count_mcp_servers(snapshot.mcp.as_ref()),
        assistants: count_domain(snapshot.assistants.as_ref()),
        skills_selection: count_domain(snapshot.skills_selection.as_ref()),
        system: count_domain(snapshot.system.as_ref()),
    }
}

pub fn build_backup_manifest(snapshot: &BackupSnapshot) -> BackupManifest {
    BackupManifest {
        protocol_version: BACKUP_PROTOCOL_VERSION,
        schema_version: BACKUP_SCHEMA_VERSION,
        snapshot_id: uuid::Uuid::new_v4().to_string(),
        created_at: rfc3339_now(),
        device_name: backup_device_name(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        encryption: default_backup_encryption(),
        domains: snapshot_domain_counts(snapshot),
    }
}

// ---------------------------------------------------------------------------
// 各域采集（~/.ReinAgent 下的文件 + plugin-store 的 settings.json）
// ---------------------------------------------------------------------------

fn provider_config_path() -> PathBuf {
    config_dir().join("provider_config.json")
}

fn mcp_servers_path() -> PathBuf {
    config_dir().join("mcp_servers.json")
}

fn assistants_dir() -> PathBuf {
    config_dir().join("assistants")
}

/// plugin-store 的 settings.json 路径（AppData/Roaming/<identifier>/settings.json）。
///
/// Windows = `%APPDATA%`，Linux/macOS = `~/.config`（dirs::config_dir 与 tauri
/// 的 app_config_dir 同源）。identifier 硬编码为编译期常量 —— 与 tauri.conf.json
/// 一致，避免在无 App 运行时（单测）解析失败。
fn plugin_store_settings_path() -> Option<PathBuf> {
    const APP_IDENTIFIER: &str = "com.web3claw.reinagent";
    dirs::config_dir().map(|dir| dir.join(APP_IDENTIFIER).join("settings.json"))
}

/// 读 settings.json 的 `settings` 键，过滤出白名单键（可移植子集）。
/// 文件不存在 / 无该键 / 无白名单键 → None。
fn load_system_portable_subset() -> Result<Option<Value>, String> {
    let Some(path) = plugin_store_settings_path() else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 settings.json 失败：{e}"))?;
    let root: Value = serde_json::from_str(&text).map_err(|e| format!("settings.json 解析失败：{e}"))?;
    let settings = root.get("settings").cloned().unwrap_or(Value::Null);
    let Value::Object(map) = settings else {
        return Ok(None);
    };
    let portable: Map<String, Value> = map
        .into_iter()
        .filter(|(key, _)| SYSTEM_PORTABLE_KEYS.contains(&key.as_str()))
        .collect();
    if portable.is_empty() {
        return Ok(None);
    }
    Ok(Some(Value::Object(portable)))
}

/// 采集当前配置。五个域全部来自磁盘文件，不需要前端参与。
///
/// 注意：同步配置（WebDAV 地址/凭据，`backup_sync.json`）刻意独立存放 —— 它是
/// 设备级的，若随快照流转会让 A 机器的凭据覆盖 B 机器，形成循环。
/// 单个域读取失败时整体报错（No-Fallback：不静默跳过产出残缺快照）。
pub fn collect_backup_snapshot() -> Result<BackupSnapshot, String> {
    let providers = {
        let path = provider_config_path();
        if !path.exists() {
            None
        } else {
            let text = fs::read_to_string(&path).map_err(|e| format!("读取 provider_config.json 失败：{e}"))?;
            if text.trim().is_empty() {
                None
            } else {
                let parsed: Value =
                    serde_json::from_str(&text).map_err(|e| format!("provider_config.json 解析失败：{e}"))?;
                if !parsed.is_array() {
                    return Err("provider_config.json 结构非法（期望数组）".to_string());
                }
                Some(parsed)
            }
        }
    };
    let mcp = {
        let path = mcp_servers_path();
        if !path.exists() {
            None
        } else {
            let text = fs::read_to_string(&path).map_err(|e| format!("读取 mcp_servers.json 失败：{e}"))?;
            if text.trim().is_empty() {
                None
            } else {
                let parsed: Value =
                    serde_json::from_str(&text).map_err(|e| format!("mcp_servers.json 解析失败：{e}"))?;
                if !parsed.is_array() {
                    return Err("mcp_servers.json 结构非法（期望数组）".to_string());
                }
                Some(parsed)
            }
        }
    };
    let assistants = collect_assistants_documents()?;
    let skills_selection = load_skills_selection()?;
    let system = load_system_portable_subset()?;
    Ok(BackupSnapshot {
        providers,
        mcp,
        assistants,
        skills_selection,
        system,
    })
}

/// 采集助手文档：目录下全部 .md，按文件名排序保证快照确定性。
fn collect_assistants_documents() -> Result<Option<Value>, String> {
    let dir = assistants_dir();
    if !dir.exists() {
        return Ok(None);
    }
    let mut names: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| format!("读取助手目录失败：{e}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_md = name.to_ascii_lowercase().ends_with(".md");
            let is_file = entry.path().is_file();
            is_md.then_some(name).filter(|_| is_file)
        })
        .collect();
    names.sort();
    let mut docs = Vec::new();
    for name in names {
        let path = dir.join(&name);
        let content = fs::read_to_string(&path).map_err(|e| format!("读取助手 {} 失败：{e}", name))?;
        docs.push(serde_json::json!({
            "id": name.trim_end_matches(".md").trim_end_matches(".MD"),
            "name": name,
            "content": content,
        }));
    }
    if docs.is_empty() {
        return Ok(None);
    }
    Ok(Some(Value::Array(docs)))
}

/// 读取技能启用清单（kv 表 `reinagent-skills-settings` 的 selected 字段）。
/// 直接读 conversations.db 的 kv 表（不依赖前端缓存）。
fn load_skills_selection() -> Result<Option<Value>, String> {
    let db_path = crate::app_proxy::kv_db_path();
    if !db_path.exists() {
        return Ok(None);
    }
    let conn = rusqlite::Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("打开 kv 库失败：{e}"))?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM kv WHERE key = 'reinagent-skills-settings'",
            [],
            |row| row.get(0),
        )
        .ok();
    let Some(raw) = raw else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("技能设置 kv 解析失败：{e}"))?;
    let selected = parsed.get("selected").cloned().unwrap_or(Value::Null);
    match selected {
        Value::Array(items) => {
            if items.is_empty() {
                Ok(None)
            } else {
                Ok(Some(Value::Array(items)))
            }
        }
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// 校验 / 序列化
// ---------------------------------------------------------------------------

/// 校验 manifest 的版本兼容性。高于当前支持的版本一律拒绝，
/// 避免把读不懂的数据当成「空配置」写入而静默清库。
pub fn validate_backup_manifest(manifest: &BackupManifest) -> Result<(), String> {
    if manifest.protocol_version > BACKUP_PROTOCOL_VERSION {
        return Err(format!(
            "备份文件格式版本 {} 高于当前支持的 {BACKUP_PROTOCOL_VERSION}，请升级应用后重试",
            manifest.protocol_version
        ));
    }
    if manifest.schema_version > BACKUP_SCHEMA_VERSION {
        return Err(format!(
            "备份文件配置版本 {} 高于当前支持的 {BACKUP_SCHEMA_VERSION}，请升级应用后重试",
            manifest.schema_version
        ));
    }
    if manifest.encryption != "none" {
        return Err(format!("暂不支持的加密方式：{}", manifest.encryption));
    }
    Ok(())
}

/// 结构校验：各域必须是预期的 JSON 形状，拒绝畸形输入。
pub fn validate_backup_snapshot(snapshot: &BackupSnapshot) -> Result<(), String> {
    if let Some(providers) = &snapshot.providers {
        if !providers.is_array() {
            return Err("备份内容 providers 必须是数组".to_string());
        }
    }
    if let Some(mcp) = &snapshot.mcp {
        if !mcp.is_array() {
            return Err("备份内容 mcp 必须是数组".to_string());
        }
    }
    if let Some(assistants) = &snapshot.assistants {
        let items = assistants
            .as_array()
            .ok_or_else(|| "备份内容 assistants 必须是数组".to_string())?;
        for item in items {
            let object = item
                .as_object()
                .ok_or_else(|| "备份内容 assistants 条目必须是对象".to_string())?;
            let id = object.get("id").and_then(Value::as_str).unwrap_or("");
            let content = object.get("content").and_then(Value::as_str).unwrap_or("");
            // 文件名安全：id 会成为目标机上的文件名。
            if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
                return Err(format!("备份内容助手 id 非法：{id}"));
            }
            if content.is_empty() {
                return Err(format!("备份助手 {id} 内容为空"));
            }
        }
    }
    if let Some(skills) = &snapshot.skills_selection {
        if !skills.is_array() {
            return Err("备份内容 skillsSelection 必须是数组".to_string());
        }
    }
    if let Some(system) = &snapshot.system {
        if !system.is_object() {
            return Err("备份内容 system 必须是对象".to_string());
        }
    }
    Ok(())
}

/// 序列化为导出文件内容：快照 + 内联 manifest，单文件自包含。
pub fn serialize_backup_document(snapshot: &BackupSnapshot, manifest: &BackupManifest) -> Result<String, String> {
    let mut document = match serde_json::to_value(snapshot).map_err(|e| format!("序列化备份内容失败：{e}"))? {
        Value::Object(map) => map,
        _ => return Err("序列化备份内容失败：预期对象".to_string()),
    };
    document.insert(
        BACKUP_MANIFEST_FIELD.to_string(),
        serde_json::to_value(manifest).map_err(|e| format!("序列化备份元信息失败：{e}"))?,
    );
    serde_json::to_string_pretty(&Value::Object(document)).map_err(|e| format!("序列化备份文件失败：{e}"))
}

/// 解析导出文件内容，返回 (快照, manifest)。已完成版本与结构校验。
pub fn parse_backup_document(raw: &str) -> Result<(BackupSnapshot, BackupManifest), String> {
    let mut document = match serde_json::from_str::<Value>(raw).map_err(|e| format!("备份文件解析失败：{e}"))? {
        Value::Object(map) => map,
        _ => return Err("备份文件必须是 JSON 对象".to_string()),
    };
    let manifest_value = document
        .remove(BACKUP_MANIFEST_FIELD)
        .ok_or_else(|| "备份文件缺少元信息，可能不是 ReinAgent 导出的配置".to_string())?;
    let manifest = serde_json::from_value::<BackupManifest>(manifest_value)
        .map_err(|e| format!("解析备份元信息失败：{e}"))?;
    validate_backup_manifest(&manifest)?;

    let snapshot = serde_json::from_value::<BackupSnapshot>(Value::Object(document))
        .map_err(|e| format!("解析备份内容失败：{e}"))?;
    validate_backup_snapshot(&snapshot)?;
    Ok((snapshot, manifest))
}

/// 应用前把当前配置备份到 ~/.ReinAgent/backups/，保留最近 BACKUP_RETENTION 份。
pub fn backup_current_config() -> Result<Option<String>, String> {
    let snapshot = collect_backup_snapshot()?;
    let manifest = build_backup_manifest(&snapshot);
    let document = serialize_backup_document(&snapshot, &manifest)?;

    let dir = backup_dir()?;
    let filename = format!("config-{}.json", now_ms());
    let path = dir.join(filename);
    fs::write(&path, document).map_err(|e| format!("写入备份文件失败：{e}"))?;
    prune_backups(&dir)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn prune_backups(dir: &std::path::Path) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取备份目录失败：{e}"))?;
    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("config-") && name.ends_with(".json"))
        })
        .collect();
    if files.len() <= BACKUP_RETENTION {
        return Ok(());
    }
    // 文件名内嵌毫秒时间戳，字典序即时间序。
    files.sort();
    for path in files.iter().take(files.len() - BACKUP_RETENTION) {
        // 清理失败不应阻断主流程。
        let _ = fs::remove_file(path);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// provider id 重映射（跨设备导入时把源设备 id 改写回本机 id）
// ---------------------------------------------------------------------------

/// 读取 provider 对象的字符串字段（trim 后）；缺失或非字符串按空串处理。
fn provider_string_field(provider: &Value, key: &str) -> String {
    provider
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

/// baseUrl 归一化：去首尾空白与尾部斜杠。两台设备手填同一端点时最常见的
/// 分歧就是结尾多一个 `/`；host 大小写等更激进的归一不做 —— 配对错了会把
/// 本机引用续到另一个账号上，宁可少配也不错配。
fn normalized_provider_base_url(provider: &Value) -> String {
    provider_string_field(provider, "baseUrl").trim_end_matches('/').to_string()
}

/// provider 身份指纹，用于跨设备识别「同一个服务商配置」。
struct ProviderIdentity {
    id: String,
    base_url: String,
    name: String,
}

fn provider_identities(providers: &[Value]) -> Vec<ProviderIdentity> {
    providers
        .iter()
        .filter_map(|provider| {
            let id = provider_string_field(provider, "id");
            if id.is_empty() {
                return None;
            }
            Some(ProviderIdentity {
                id,
                base_url: normalized_provider_base_url(provider),
                name: provider_string_field(provider, "name"),
            })
        })
        .collect()
}

/// 在未消耗的两侧候选中按 key 配对：某个 key 在两侧各恰好出现一次时才认定
/// 为同一 provider。出现多个候选（同端点多账号）时无法分辨哪个对哪个，
/// 跳过不配 —— 退回「保留源 id」的旧行为，引用失效但不会张冠李戴。
fn match_unique_identity<K: std::hash::Hash + Eq>(
    incoming: &[ProviderIdentity],
    incoming_taken: &mut [bool],
    local: &[ProviderIdentity],
    local_taken: &mut [bool],
    id_map: &mut std::collections::HashMap<String, String>,
    key_of: impl Fn(&ProviderIdentity) -> Option<K>,
) {
    let mut incoming_counts: std::collections::HashMap<K, usize> = std::collections::HashMap::new();
    for (index, identity) in incoming.iter().enumerate() {
        if incoming_taken[index] {
            continue;
        }
        if let Some(key) = key_of(identity) {
            *incoming_counts.entry(key).or_default() += 1;
        }
    }
    // key → (未消耗候选数, 最后一个候选下标)；仅当数量为 1 时下标才有意义。
    let mut local_slots: std::collections::HashMap<K, (usize, usize)> = std::collections::HashMap::new();
    for (index, identity) in local.iter().enumerate() {
        if local_taken[index] {
            continue;
        }
        if let Some(key) = key_of(identity) {
            let slot = local_slots.entry(key).or_insert((0, index));
            slot.0 += 1;
            slot.1 = index;
        }
    }
    // 按 incoming 原始顺序应用配对，结果与 HashMap 迭代顺序无关。
    for (index, identity) in incoming.iter().enumerate() {
        if incoming_taken[index] {
            continue;
        }
        let Some(key) = key_of(identity) else {
            continue;
        };
        if incoming_counts.get(&key) != Some(&1) {
            continue;
        }
        let Some(&(count, local_index)) = local_slots.get(&key) else {
            continue;
        };
        if count != 1 || local_taken[local_index] {
            continue;
        }
        incoming_taken[index] = true;
        local_taken[local_index] = true;
        if identity.id != local[local_index].id {
            id_map.insert(identity.id.clone(), local[local_index].id.clone());
        }
    }
}

/// 备份里的自定义 provider id 是源设备随机生成的（`custom-<时间戳>`）；快照内
/// system 默认模型指针与助手 frontmatter 的 `model: "providerId/modelId"` 引用的是
/// 源 id。整域覆盖时若原样写入源 id，这些引用会整体失配（No-Fallback 链路会把
/// 未知 provider 静默跳过，用户看到的是「默认模型/助手绑定失效」）。导入前把
/// 「同一身份」的备份 provider 改写回本机 id，引用即可无感存续。
///
/// 两级配对，逐级放宽且互斥（配对成功即从两侧候选中剔除）：
/// 1. id 相同 —— 预设槽位（deepseek 等）、以及已同步过一次的设备；
/// 2. baseUrl + name 全同，两侧唯一（覆盖仅改过显示名之外的场景）。
///
/// 内置预设 id（deepseek/openai 等）在两侧天然一致，第 1 级直接消耗；
/// 自定义供应商按第 2 级配对，猜不准时宁可保留源 id。
///
/// 返回 源 id → 本机 id，仅含两者不同的条目。
fn build_provider_id_map(incoming: &[Value], local: &[Value]) -> std::collections::HashMap<String, String> {
    let incoming = provider_identities(incoming);
    let local = provider_identities(local);
    let mut incoming_taken = vec![false; incoming.len()];
    let mut local_taken = vec![false; local.len()];

    // 第 1 级：id 直接相同，无需改写，只把两侧候选标记为已消耗。
    let local_index_by_id: std::collections::HashMap<&str, usize> = local
        .iter()
        .enumerate()
        .map(|(index, identity)| (identity.id.as_str(), index))
        .collect();
    for (index, identity) in incoming.iter().enumerate() {
        if let Some(&local_index) = local_index_by_id.get(identity.id.as_str()) {
            if !local_taken[local_index] {
                incoming_taken[index] = true;
                local_taken[local_index] = true;
            }
        }
    }

    let mut id_map = std::collections::HashMap::new();
    match_unique_identity(
        &incoming,
        &mut incoming_taken,
        &local,
        &mut local_taken,
        &mut id_map,
        |identity| {
            (!identity.base_url.is_empty()).then(|| (identity.base_url.clone(), identity.name.clone()))
        },
    );
    id_map
}

/// 把 id 映射应用到快照：providers[].id、system 的默认模型指针、助手
/// frontmatter 的 `model: "providerId/modelId"` 必须一起改写，否则引用指向
/// 不存在的 provider，No-Fallback 链路会静默跳过。
fn rewrite_snapshot_provider_ids(snapshot: &mut BackupSnapshot, id_map: &std::collections::HashMap<String, String>) {
    if id_map.is_empty() {
        return;
    }
    if let Some(Value::Array(providers)) = snapshot.providers.as_mut() {
        for provider in providers.iter_mut() {
            let Some(object) = provider.as_object_mut() else {
                continue;
            };
            let Some(source_id) = object.get("id").and_then(Value::as_str) else {
                continue;
            };
            if let Some(local_id) = id_map.get(source_id.trim()) {
                object.insert("id".to_string(), Value::String(local_id.clone()));
            }
        }
    }
    if let Some(Value::Object(system)) = snapshot.system.as_mut() {
        if let Some(source_id) = system.get("provider").and_then(Value::as_str) {
            if let Some(local_id) = id_map.get(source_id.trim()) {
                system.insert("provider".to_string(), Value::String(local_id.clone()));
            }
        }
    }
    if let Some(Value::Array(assistants)) = snapshot.assistants.as_mut() {
        for doc in assistants.iter_mut() {
            let Some(object) = doc.as_object_mut() else {
                continue;
            };
            let Some(content) = object.get("content").and_then(Value::as_str) else {
                continue;
            };
            let rewritten = rewrite_assistant_model_bindings(content, id_map);
            if rewritten != content {
                object.insert("content".to_string(), Value::String(rewritten));
            }
        }
    }
}

/// 改写一份助手 .md 文档 frontmatter 里的 `model:` 行（"providerId/modelId"）。
/// 只处理 frontmatter（首个 `---` 块）内以 `model:` 开头的行，正文不动。
fn rewrite_assistant_model_bindings(content: &str, id_map: &std::collections::HashMap<String, String>) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut in_frontmatter = false;
    let mut frontmatter_closed = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            if !in_frontmatter && !frontmatter_closed {
                in_frontmatter = true;
            } else {
                in_frontmatter = false;
                frontmatter_closed = true;
            }
            lines.push(line.to_string());
            continue;
        }
        if in_frontmatter {
            if let Some(rest) = trimmed.strip_prefix("model:") {
                let value = rest.trim().trim_matches('"').trim_matches('\'');
                if let Some(slash) = value.find('/') {
                    let provider = value[..slash].trim();
                    let model = value[slash + 1..].trim();
                    if let Some(local_id) = id_map.get(provider) {
                        lines.push(format!("model: {local_id}/{model}"));
                        continue;
                    }
                }
            }
        }
        lines.push(line.to_string());
    }
    // 保持原换行风格（文档可能以 \n 结尾）。
    if content.ends_with('\n') {
        lines.push(String::new());
    }
    lines.join("\n")
}

/// 导入前的 id 重映射入口。providers 域缺失时没有源侧身份可配，直接跳过；
/// 本机没有任何 provider 时也没有引用需要保全，快照原样落库。
fn remap_snapshot_provider_ids_to_local(snapshot: &mut BackupSnapshot) -> Result<(), String> {
    let id_map = {
        let Some(Value::Array(incoming)) = snapshot.providers.as_ref() else {
            return Ok(());
        };
        let path = provider_config_path();
        let local: Vec<Value> = if !path.exists() {
            Vec::new()
        } else {
            let text = fs::read_to_string(&path).map_err(|e| format!("读取 provider_config.json 失败：{e}"))?;
            serde_json::from_str::<Vec<Value>>(&text).unwrap_or_default()
        };
        build_provider_id_map(incoming, &local)
    };
    rewrite_snapshot_provider_ids(snapshot, &id_map);
    Ok(())
}

// ---------------------------------------------------------------------------
// 应用快照（整域覆盖写盘）
// ---------------------------------------------------------------------------

/// 把 system 白名单键叠加进本机 settings.json 的 `settings` 键。
///
/// 不能整文件覆盖 —— settings.json 还有 stt 等设备本地段；也不能拿快照的
/// system 直接替换 `settings` 键 —— 目标机未备份的键（如自定义 baseUrl 变体）
/// 应保持本机原值。只叠加白名单键。
fn merge_system_into_plugin_store(snapshot_system: &Value) -> Result<(), String> {
    let Some(snapshot_map) = snapshot_system.as_object() else {
        return Ok(());
    };
    let Some(path) = plugin_store_settings_path() else {
        return Err("无法定位 settings.json 存储路径".to_string());
    };
    let mut root: Map<String, Value> = if path.exists() {
        let text = fs::read_to_string(&path).map_err(|e| format!("读取 settings.json 失败：{e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("settings.json 解析失败：{e}"))?
    } else {
        Map::new()
    };
    let settings = root
        .entry("settings")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(settings_map) = settings.as_object_mut() else {
        return Err("settings.json 的 settings 键结构非法".to_string());
    };
    for key in SYSTEM_PORTABLE_KEYS {
        if let Some(value) = snapshot_map.get(*key) {
            settings_map.insert((*key).to_string(), value.clone());
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| format!("序列化 settings.json 失败：{e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入 settings.json 失败：{e}"))
}

/// 整域覆盖写入（纯写盘，不做备份）。中途失败理论上会留下半套配置——防线是
/// 调用方：写盘前已完成完整校验（畸形输入一行都不会写），且写盘前已生成本地
/// 备份可回退。各域写入顺序：providers → mcp → assistants → skillsSelection → system。
pub fn apply_backup_snapshot_to_disk(snapshot: &BackupSnapshot) -> Result<(), String> {
    let mut snapshot = snapshot.clone();
    remap_snapshot_provider_ids_to_local(&mut snapshot)?;

    if let Some(providers) = snapshot.providers.take() {
        let path = provider_config_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
        }
        let text =
            serde_json::to_string_pretty(&providers).map_err(|e| format!("序列化 providers 失败：{e}"))?;
        fs::write(&path, text).map_err(|e| format!("写入 provider_config.json 失败：{e}"))?;
    }
    if let Some(mcp) = snapshot.mcp.take() {
        let path = mcp_servers_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
        }
        let text = serde_json::to_string_pretty(&mcp).map_err(|e| format!("序列化 mcp 失败：{e}"))?;
        fs::write(&path, text).map_err(|e| format!("写入 mcp_servers.json 失败：{e}"))?;
    }
    if let Some(assistants) = snapshot.assistants.take() {
        let dir = assistants_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("创建助手目录失败：{e}"))?;
        let Some(items) = assistants.as_array() else {
            return Err("备份内容 assistants 必须是数组".to_string());
        };
        for doc in items {
            let id = doc.get("id").and_then(Value::as_str).unwrap_or("");
            let content = doc.get("content").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() || content.is_empty() {
                continue; // 校验阶段已拦截，此处兜底跳过而不是写坏文件
            }
            let path = dir.join(format!("{id}.md"));
            fs::write(&path, content).map_err(|e| format!("写入助手 {id} 失败：{e}"))?;
        }
    }
    if let Some(skills) = snapshot.skills_selection.take() {
        let db_path = crate::app_proxy::kv_db_path();
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败：{e}"))?;
        }
        let conn = rusqlite::Connection::open(&db_path).map_err(|e| format!("打开 kv 库失败：{e}"))?;
        conn.execute_batch("PRAGMA busy_timeout = 5000;").ok();
        // 保持 kv 既有结构：enabled + selected 两字段（enabled 保留本机值）。
        let existing: Option<String> = conn
            .query_row(
                "SELECT value FROM kv WHERE key = 'reinagent-skills-settings'",
                [],
                |row| row.get(0),
            )
            .ok();
        let mut merged: Map<String, Value> = existing
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        merged.insert("selected".to_string(), skills);
        let text = serde_json::to_string(&Value::Object(merged)).map_err(|e| format!("序列化技能设置失败：{e}"))?;
        conn.execute(
            "INSERT INTO kv (key, value) VALUES ('reinagent-skills-settings', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [text],
        )
        .map_err(|e| format!("写入技能设置失败：{e}"))?;
    }
    if let Some(system) = snapshot.system.take() {
        merge_system_into_plugin_store(&system)?;
    }
    Ok(())
}

/// 应用一份快照：校验 → 备份当前配置 → 写盘。
pub fn apply_backup_snapshot(snapshot: BackupSnapshot) -> Result<BackupApplyOutcome, String> {
    validate_backup_snapshot(&snapshot)?;
    let applied = snapshot_domain_counts(&snapshot);
    let backup_path = backup_current_config()?;

    apply_backup_snapshot_to_disk(&snapshot)?;

    Ok(BackupApplyOutcome { applied, backup_path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manifest_roundtrip_and_version_gate() {
        let snapshot = BackupSnapshot {
            providers: Some(json!([{"id": "deepseek"}])),
            ..Default::default()
        };
        let manifest = build_backup_manifest(&snapshot);
        let document = serialize_backup_document(&snapshot, &manifest).unwrap();
        let (parsed_snapshot, parsed_manifest) = parse_backup_document(&document).unwrap();
        assert_eq!(parsed_manifest.protocol_version, BACKUP_PROTOCOL_VERSION);
        assert_eq!(parsed_snapshot.providers, snapshot.providers);

        // 高版本一律拒绝。
        let mut high = parsed_manifest.clone();
        high.protocol_version = BACKUP_PROTOCOL_VERSION + 1;
        let document = serialize_backup_document(&snapshot, &high).unwrap();
        assert!(parse_backup_document(&document).is_err());
        let mut high_schema = parsed_manifest.clone();
        high_schema.schema_version = BACKUP_SCHEMA_VERSION + 1;
        let document = serialize_backup_document(&snapshot, &high_schema).unwrap();
        assert!(parse_backup_document(&document).is_err());
        // 未知加密方式拒绝。
        let mut enc = parsed_manifest;
        enc.encryption = "age".to_string();
        let document = serialize_backup_document(&snapshot, &enc).unwrap();
        assert!(parse_backup_document(&document).is_err());
    }

    #[test]
    fn missing_manifest_field_is_rejected() {
        assert!(parse_backup_document("{\"providers\": []}").is_err());
    }

    #[test]
    fn malformed_domains_are_rejected() {
        let base = r#"{"_manifest":{"protocolVersion":1,"schemaVersion":1,"snapshotId":"x","createdAt":"2026-01-01T00:00:00Z","deviceName":"d","appVersion":"0.1.0","encryption":"none"}}"#;
        assert!(parse_backup_document(&base.replacen("{", "{\"providers\": 42,", 1)).is_err());
        assert!(parse_backup_document(&base.replacen("{", "{\"mcp\": {},", 1)).is_err());
        assert!(parse_backup_document(&base.replacen("{", "{\"skillsSelection\": \"x\",", 1)).is_err());
        assert!(parse_backup_document(&base.replacen("{", "{\"system\": [],", 1)).is_err());
        // 助手 id 带路径穿越。
        let evil = base.replacen("{", "{\"assistants\": [{\"id\": \"../evil\", \"content\": \"x\"}],", 1);
        assert!(parse_backup_document(&evil).is_err());
    }

    #[test]
    fn provider_id_map_prefers_id_then_identity() {
        let incoming = vec![
            json!({"id": "custom-src", "name": "My Gateway", "baseUrl": "http://gw:8080"}),
            json!({"id": "deepseek", "name": "DeepSeek", "baseUrl": "https://api.deepseek.com"}),
            json!({"id": "ambig-a", "name": "Dup", "baseUrl": "http://dup:1"}),
            json!({"id": "ambig-b", "name": "Dup", "baseUrl": "http://dup:1"}),
        ];
        let local = vec![
            json!({"id": "deepseek", "name": "DeepSeek", "baseUrl": "https://api.deepseek.com"}),
            json!({"id": "custom-local", "name": "My Gateway", "baseUrl": "http://gw:8080/"}),
            json!({"id": "dup-1", "name": "Dup", "baseUrl": "http://dup:1"}),
            json!({"id": "dup-2", "name": "Dup", "baseUrl": "http://dup:1"}),
        ];
        let map = build_provider_id_map(&incoming, &local);
        // 唯一身份配对成功；deepseek id 相同不进 map；同端点多候选猜不准不配。
        assert_eq!(map.get("custom-src").map(String::as_str), Some("custom-local"));
        assert!(!map.contains_key("deepseek"));
        assert!(!map.contains_key("ambig-a"));
        assert!(!map.contains_key("ambig-b"));
    }

    #[test]
    fn snapshot_remap_rewrites_providers_system_and_assistant_bindings() {
        let mut snapshot = BackupSnapshot {
            providers: Some(json!([
                {"id": "custom-src", "name": "GW", "baseUrl": "http://gw:1"},
                {"id": "deepseek", "name": "DeepSeek", "baseUrl": "https://api.deepseek.com"}
            ])),
            system: Some(json!({"provider": "custom-src", "modelId": "m1"})),
            assistants: Some(json!([
                {"id": "coder", "name": "coder.md", "content": "---\nname: coder\ndescription: d\nmodel: custom-src/gw-model\n---\n\n正文 model: custom-src/x 不动\n"}
            ])),
            ..Default::default()
        };
        let local = vec![json!({"id": "custom-local", "name": "GW", "baseUrl": "http://gw:1"})];
        let map = build_provider_id_map(
            snapshot.providers.as_ref().unwrap().as_array().unwrap(),
            &local,
        );
        rewrite_snapshot_provider_ids(&mut snapshot, &map);

        let providers = snapshot.providers.unwrap();
        assert_eq!(providers[0]["id"], "custom-local");
        assert_eq!(providers[1]["id"], "deepseek");
        let system = snapshot.system.unwrap();
        assert_eq!(system["provider"], "custom-local");
        let assistants = snapshot.assistants.unwrap();
        let content = assistants[0]["content"].as_str().unwrap();
        assert!(content.contains("model: custom-local/gw-model"), "{content}");
        assert!(content.contains("正文 model: custom-src/x 不动"), "{content}");
    }

    #[test]
    fn rewrite_assistant_model_bindings_keeps_non_matching() {
        let map = std::collections::HashMap::from([("src".to_string(), "loc".to_string())]);
        let doc = "---\nname: x\nmodel: keep/other\nskills: a, b\n---\nbody";
        let out = rewrite_assistant_model_bindings(doc, &map);
        assert_eq!(out, doc);
        let doc2 = "---\nname: x\nmodel: src/m\n---\nbody";
        assert_eq!(rewrite_assistant_model_bindings(doc2, &map), "---\nname: x\nmodel: loc/m\n---\nbody");
    }

    #[test]
    fn system_whitelist_only_carries_portable_keys() {
        // 白名单过滤逻辑单测：模拟一个 settings map。
        let full = json!({
            "provider": "custom-1",
            "apiKey": "sk-x",
            "modelId": "m",
            "baseUrl": "http://x",
            "evilLocalOnly": "should-not-carry"
        });
        let map = full.as_object().unwrap();
        let portable: Map<String, Value> = map
            .iter()
            .filter(|(k, _)| SYSTEM_PORTABLE_KEYS.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        assert!(portable.contains_key("provider"));
        assert!(!portable.contains_key("evilLocalOnly"));
    }
}
