//! WebDAV 备份同步编排（LiveAgent `commands/config/settings/webdav_sync.rs` +
//! `services/webdav_auto_sync.rs` 同构移植）：设置存取 + 上传/下载命令 + 自动上传。
//!
//! 分层：本文件只做编排与校验，所有 HTTP 细节在 `webdav.rs`。
//! 快照的采集/校验/应用复用 `backup_snapshot.rs`，与本地导入导出同一套代码路径。
//!
//! **自动同步只上传，不下载。** 自动拉取远端会在用户毫无察觉的情况下覆盖本机
//! 配置，出错方向不可接受，因此拉取永远是手动动作。

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    OnceLock,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::{sync::mpsc, time::Duration};

use crate::backup_snapshot::{
    apply_backup_snapshot, build_backup_manifest, collect_backup_snapshot, parse_backup_document,
    serialize_backup_document, BackupApplyOutcome, BackupManifest,
};
use crate::webdav::{self, WebdavCredentials};

/// 远端布局的版本目录。协议或 schema 不兼容演进时换目录，
/// 让新旧版本客户端各读各的，而不是互相写坏同一份文件。
const WEBDAV_LAYOUT_DIR: &str = "v1";
/// manifest 体积上限：它只有几百字节，1 MiB 已是极宽松的上界。
const WEBDAV_MANIFEST_MAX_BYTES: usize = 1024 * 1024;
/// config 体积上限，与本地导入的上限保持一致。
const WEBDAV_CONFIG_MAX_BYTES: usize = 16 * 1024 * 1024;
const WEBDAV_MANIFEST_FILENAME: &str = "manifest.json";
const WEBDAV_CONFIG_FILENAME: &str = "config.json";
const WEBDAV_DEFAULT_PROFILE: &str = "default";
const WEBDAV_DEFAULT_REMOTE_DIR: &str = "ReinAgent";

/// 同步配置落盘文件（~/.ReinAgent/backup_sync.json）。
const BACKUP_SYNC_FILENAME: &str = "backup_sync.json";

/// 变更后等待这么久没有新变更才上传。
const DEBOUNCE: Duration = Duration::from_secs(1);
/// 防抖的硬上限。持续编辑（例如逐字输入 API Key）会不断刷新防抖窗口，
/// 没有上限的话可以无限推迟上传。
const MAX_WAIT: Duration = Duration::from_secs(10);

/// 自动同步结果事件。手动同步的成败由命令的返回值同步告知前端，
/// 不走这个事件 —— 所以收到事件就意味着「后台自动同步」。
const STATUS_EVENT: &str = "backup-sync-status-updated";
/// 下载应用完成事件：前端据此重载各配置域的内存态。
const APPLIED_EVENT: &str = "backup:applied";

// ---------------------------------------------------------------------------
// 同步配置（设备级，不进快照）
// ---------------------------------------------------------------------------

/// 同步配置。
///
/// 存于独立文件 `backup_sync.json`，**不进配置快照** —— 它是设备级的，
/// 若随快照流转会让 A 机器的凭据覆盖 B 机器，形成循环。也刻意不放
/// conversations.db 的 kv 表（前端全量缓存进 webview 内存，密码会摊在
/// webview 侧）—— 本文件由 Rust 侧持有，命令只返回不含密码的视图。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// 远端根目录，相对于 url。
    #[serde(default = "default_backup_remote_dir")]
    pub remote_dir: String,
    /// 同一账号下的多套配置隔离（如 work / personal）。
    #[serde(default = "default_backup_profile")]
    pub profile: String,
    /// 自动同步开关（**仅自动上传，不会自动下载**）。
    #[serde(default)]
    pub auto_sync: bool,
    /// 最近一次同步成功的时间（毫秒）。
    #[serde(default)]
    pub last_sync_at: Option<i64>,
    /// 最近一次**自动**同步的失败原因。
    ///
    /// 只记录自动路径：手动同步的成败由命令返回值当场反馈，用户就在屏幕前，
    /// 不需要留痕。自动同步发生在后台，用户多半不在设置页，错误只存在于前端
    /// state 的话页面一卸载就丢了，用户永远不知道自己的配置早就没在同步。
    #[serde(default)]
    pub last_error: Option<String>,
}

fn default_backup_remote_dir() -> String {
    WEBDAV_DEFAULT_REMOTE_DIR.to_string()
}

fn default_backup_profile() -> String {
    WEBDAV_DEFAULT_PROFILE.to_string()
}

impl Default for BackupSyncConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            username: String::new(),
            password: String::new(),
            remote_dir: default_backup_remote_dir(),
            profile: default_backup_profile(),
            auto_sync: false,
            last_sync_at: None,
            last_error: None,
        }
    }
}

/// 保存请求。password 与 passwordTouched 分离是为了让 UI 能展示掩码占位符
/// 而不必把真密码回传前端 —— 用户没动密码框时，后端沿用盘上的旧值。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncConfigRequest {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub password_touched: bool,
    #[serde(default = "default_backup_remote_dir")]
    pub remote_dir: String,
    #[serde(default = "default_backup_profile")]
    pub profile: String,
    #[serde(default)]
    pub auto_sync: bool,
}

/// 回传前端的配置视图：**不含密码**，只告知是否已设置。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncConfigView {
    pub url: String,
    pub username: String,
    pub has_password: bool,
    pub remote_dir: String,
    pub profile: String,
    pub auto_sync: bool,
    pub last_sync_at: Option<i64>,
    /// 最近一次自动同步的失败原因；成功或从未失败为 None。
    pub last_error: Option<String>,
}

/// 远端备份的摘要，供上传/下载前的确认对话框展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRemoteInfo {
    pub manifest: BackupManifest,
    pub size: usize,
    pub sha256: String,
}

/// 远端 manifest：在导出 manifest 的基础上多带 config.json 的大小与摘要，
/// 用于下载后校验完整性（PUT 可能被中断，留下截断的 config.json）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupRemoteManifest {
    #[serde(flatten)]
    manifest: BackupManifest,
    #[serde(default)]
    size: usize,
    #[serde(default)]
    sha256: String,
}

impl From<BackupSyncConfig> for BackupSyncConfigView {
    fn from(config: BackupSyncConfig) -> Self {
        Self {
            url: config.url,
            username: config.username,
            has_password: !config.password.is_empty(),
            remote_dir: config.remote_dir,
            profile: config.profile,
            auto_sync: config.auto_sync,
            last_sync_at: config.last_sync_at,
            last_error: config.last_error,
        }
    }
}

/// 串行化所有远端读写。
///
/// 上传是「PUT config → PUT manifest」两步，并发执行会让两个文件来自不同快照，
/// 下载侧的 sha256 校验就会失败。
fn backup_sync_mutex() -> &'static tokio::sync::Mutex<()> {
    static MUTEX: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    MUTEX.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 清洗一段远端路径：去首尾斜杠，并丢弃 `.` / `..` 段。
///
/// `join_url` 逐段 percent-encode，而 `.` 与 `..` 都不在转义集里，会原样留在
/// URL 路径里由服务器按相对路径解析。用户在「远端目录」里填 `../../etc`，
/// 请求就会打到 WebDAV 根目录之外 —— 上传时那是把全部明文 API key PUT 到
/// 非预期路径，下载时是从非预期路径读回来当配置应用。
fn sanitize_remote_path(raw: &str) -> String {
    raw.split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_backup_sync_config(mut config: BackupSyncConfig) -> BackupSyncConfig {
    config.url = config.url.trim().trim_end_matches('/').to_string();
    config.username = config.username.trim().to_string();
    config.remote_dir = sanitize_remote_path(&config.remote_dir);
    if config.remote_dir.is_empty() {
        config.remote_dir = default_backup_remote_dir();
    }
    config.profile = sanitize_remote_path(&config.profile);
    if config.profile.is_empty() {
        config.profile = default_backup_profile();
    }
    config
}

fn backup_sync_config_path() -> std::path::PathBuf {
    crate::backup_snapshot::config_dir_pub().join(BACKUP_SYNC_FILENAME)
}

pub(crate) fn load_backup_sync_config() -> Result<BackupSyncConfig, String> {
    let path = backup_sync_config_path();
    if !path.exists() {
        return Ok(BackupSyncConfig::default());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取 {BACKUP_SYNC_FILENAME} 失败：{e}"))?;
    if text.trim().is_empty() {
        return Ok(BackupSyncConfig::default());
    }
    let config = serde_json::from_str::<BackupSyncConfig>(&text).map_err(|e| format!("解析同步配置失败：{e}"))?;
    Ok(normalize_backup_sync_config(config))
}

fn persist_backup_sync_config(config: &BackupSyncConfig) -> Result<(), String> {
    let path = backup_sync_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let text =
        serde_json::to_string_pretty(config).map_err(|e| format!("序列化 {BACKUP_SYNC_FILENAME} 失败：{e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写入 {BACKUP_SYNC_FILENAME} 失败：{e}"))
}

/// 把保存请求解析成完整配置：密码未被触碰时回填盘上旧值。
///
/// 这是 cc-switch 踩过的真实坑 —— UI 给密码框填掩码占位符后原样提交，
/// 会把占位符当成新密码写盘，用户下次同步就认证失败。
fn resolve_backup_sync_config(request: BackupSyncConfigRequest, persisted: &BackupSyncConfig) -> BackupSyncConfig {
    let password = if request.password_touched {
        request.password
    } else {
        persisted.password.clone()
    };
    normalize_backup_sync_config(BackupSyncConfig {
        url: request.url,
        username: request.username,
        password,
        remote_dir: request.remote_dir,
        profile: request.profile,
        auto_sync: request.auto_sync,
        // 保存配置不改变同步时间。
        last_sync_at: persisted.last_sync_at,
        // 但要清掉旧的自动同步错误：用户刚改过配置，那条错误说的是改之前的状态，
        // 继续挂着会让人以为新配置也是坏的。下次自动同步会重新写入真实结果。
        last_error: None,
    })
}

/// 远端目录的分段：`{remote_dir}/v1/{profile}/`。
///
/// 版本段夹在中间而不是最外层，这样用户在 WebDAV 客户端里看到的是一个
/// 干净的 `reinagent/` 顶层目录，内部再按版本和 profile 分。
fn backup_remote_segments(config: &BackupSyncConfig) -> Vec<&str> {
    vec![config.remote_dir.as_str(), WEBDAV_LAYOUT_DIR, config.profile.as_str()]
}

fn backup_remote_file_segments<'a>(config: &'a BackupSyncConfig, filename: &'a str) -> Vec<&'a str> {
    let mut segments = backup_remote_segments(config);
    segments.push(filename);
    segments
}

fn backup_sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn backup_credentials(config: &BackupSyncConfig) -> Result<WebdavCredentials, String> {
    if config.url.is_empty() {
        return Err("请先填写 WebDAV 服务器地址".to_string());
    }
    if config.username.is_empty() {
        return Err("请先填写 WebDAV 用户名".to_string());
    }
    if config.password.is_empty() {
        return Err("请先填写 WebDAV 密码".to_string());
    }
    Ok(WebdavCredentials {
        base_url: config.url.clone(),
        username: config.username.clone(),
        password: config.password.clone(),
    })
}

/// 校验下载到的 config 与 manifest 声明的大小/摘要一致。
///
/// PUT 可能被中断，留下截断的 config.json；没有这道校验就会把残缺配置
/// 当成合法快照写进本地盘。
///
/// 缺字段一律当作损坏处理，**不跳过校验**。真正会命中这条分支的只有异常数据：
/// 截断的 PUT、被别的客户端改写过的 manifest。放行等于让它们绕过完整性检查
/// 直接落进本地盘。
pub(crate) fn verify_backup_payload(body: &[u8], expected_size: usize, expected_sha256: &str) -> Result<(), String> {
    if expected_size == 0 || expected_sha256.is_empty() {
        return Err(
            "远端备份元信息缺少大小或校验和，无法确认配置完整，请从源设备重新上传一次".to_string(),
        );
    }
    if body.len() != expected_size {
        return Err(format!(
            "远端配置大小校验失败：期望 {expected_size} 字节，实际 {} 字节。远端文件可能未上传完整，请从源设备重新上传",
            body.len()
        ));
    }
    let actual = backup_sha256_hex(body);
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err("远端配置校验和不匹配，文件可能已损坏，请从源设备重新上传".to_string());
    }
    Ok(())
}

/// 解析远端 manifest（含 size/sha256 扩展字段），并校验其版本兼容性。
pub(crate) fn parse_backup_remote_manifest(body: &[u8]) -> Result<BackupRemoteManifest, String> {
    let text = std::str::from_utf8(body).map_err(|_| "远端备份元信息不是合法的 UTF-8 文本".to_string())?;
    let remote = serde_json::from_str::<BackupRemoteManifest>(text)
        .map_err(|e| format!("解析远端备份元信息失败：{e}"))?;
    crate::backup_snapshot::validate_backup_manifest(&remote.manifest)?;
    Ok(remote)
}

/// 记录一次同步成功：写入时间戳并清掉遗留的自动同步错误横幅。
fn touch_backup_last_sync_at() -> Result<i64, String> {
    let timestamp = chrono::Utc::now().timestamp_millis();
    let mut config = load_backup_sync_config()?;
    config.last_sync_at = Some(timestamp);
    // 手动同步成功同样清错误：既然这条链路现在是通的，那条旧错误已经过期。
    config.last_error = None;
    persist_backup_sync_config(&config)?;
    Ok(timestamp)
}

/// 记录一次**自动**同步失败。
///
/// 尽力而为：写盘本身失败时只能放弃 —— 调用方已经处在错误路径上，
/// 再抛一个错误没有任何人能处理，反而会盖掉真正的失败原因。
fn record_backup_auto_sync_error(message: &str) {
    let Ok(mut config) = load_backup_sync_config() else {
        return;
    };
    config.last_error = Some(message.to_string());
    let _ = persist_backup_sync_config(&config);
}

// ---------------------------------------------------------------------------
// 上传 / 下载核心
// ---------------------------------------------------------------------------

/// 上传：采集 → 建目录 → **先 PUT config 再 PUT manifest**。
///
/// 顺序是有意的。manifest 是「这份备份可用」的信号，最后写入，
/// 中途失败时远端留下的是旧 manifest + 新 config，下载侧的 sha256 校验
/// 会拦下这个不一致，而不会当成合法数据应用。
///
/// **锁必须在采集之前获取。** 反过来（先采集后加锁）会开一个窗口：一次手动
/// 下载可以整个挤在采集与 PUT 之间完成，于是这次上传把下载前的旧快照盖回远端，
/// 用户刚拉下来的远端配置被自己的机器悄悄覆盖。抑制守卫挡不住这种情况 ——
/// 它只阻止下载期间新产生的标脏，管不了一个已经采完快照、正停在锁上的上传。
async fn upload_backup_snapshot() -> Result<i64, String> {
    let _guard = backup_sync_mutex().lock().await;

    let (config, manifest, document) = tauri::async_runtime::spawn_blocking(move || {
        let config = load_backup_sync_config()?;
        let snapshot = collect_backup_snapshot()?;
        let manifest = build_backup_manifest(&snapshot);
        let document = serialize_backup_document(&snapshot, &manifest)?;
        Ok::<_, String>((config, manifest, document))
    })
    .await
    .map_err(|e| format!("settings_backup_upload join 失败：{e}"))??;

    let creds = backup_credentials(&config)?;

    let body = document.into_bytes();
    let remote_manifest = BackupRemoteManifest {
        manifest,
        size: body.len(),
        sha256: backup_sha256_hex(&body),
    };
    let manifest_body = serde_json::to_vec_pretty(&remote_manifest)
        .map_err(|e| format!("序列化远端备份元信息失败：{e}"))?;

    webdav::ensure_remote_dirs(&creds, &backup_remote_segments(&config)).await?;
    webdav::put_bytes(
        &creds,
        &backup_remote_file_segments(&config, WEBDAV_CONFIG_FILENAME),
        body,
        "application/json",
    )
    .await?;
    webdav::put_bytes(
        &creds,
        &backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME),
        manifest_body,
        "application/json",
    )
    .await?;

    tauri::async_runtime::spawn_blocking(touch_backup_last_sync_at)
        .await
        .map_err(|e| format!("settings_backup_upload join 失败：{e}"))?
}

/// 自动同步的上传入口。
///
/// 与手动上传有两点不同：
/// 1. 没开开关或凭据不全就静默跳过 —— 自动路径不该因为用户没配 WebDAV 就反复弹错误。
/// 2. 失败会落盘（`last_error`）。用户此刻多半不在设置页，只靠事件推送的话
///    页面一卸载错误就没了，配置早已停止同步而用户毫不知情。
async fn auto_upload_backup_snapshot() -> Result<Option<i64>, String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config)
        .await
        .map_err(|e| format!("auto_upload_backup_snapshot join 失败：{e}"))??;
    if !config.auto_sync || backup_credentials(&config).is_err() {
        return Ok(None);
    }
    match upload_backup_snapshot().await {
        Ok(timestamp) => Ok(Some(timestamp)),
        Err(error) => {
            let message = error.clone();
            // 落盘放到 blocking 线程，避免在异步上下文里做同步文件 IO。
            let _ = tauri::async_runtime::spawn_blocking(move || {
                record_backup_auto_sync_error(&message);
            })
            .await;
            Err(error)
        }
    }
}

// ---------------------------------------------------------------------------
// 自动同步任务（标脏 → 防抖合并 → 上传）
// ---------------------------------------------------------------------------

static DIRTY_TX: OnceLock<mpsc::Sender<()>> = OnceLock::new();
static SUPPRESSION: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoSyncStatus {
    /// 毫秒时间戳，仅成功时有值。
    last_sync_at: Option<i64>,
    last_error: Option<String>,
}

/// 抑制期计数器的 RAII 句柄。
pub struct AutoSyncSuppressionGuard;

impl Drop for AutoSyncSuppressionGuard {
    fn drop(&mut self) {
        SUPPRESSION.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 下载并应用远端快照期间必须持有。
///
/// 应用快照会改写各配置域的文件；应用完成后前端各 store 重载会再次触发标脏
/// （重载本身不改文件，但保险起见整段抑制），不抑制就会把刚从远端拉下来的
/// 数据原样推回去。
pub fn suppress() -> AutoSyncSuppressionGuard {
    SUPPRESSION.fetch_add(1, Ordering::SeqCst);
    AutoSyncSuppressionGuard
}

/// 标记配置已变更。未启动自动同步任务时为空操作（单测环境即如此）。
pub fn mark_dirty() {
    if suppressed() {
        return;
    }
    if let Some(tx) = DIRTY_TX.get() {
        // 容量 1：已有未处理的脏信号时直接丢弃，防抖窗口本就会把它们合并成一次上传。
        let _ = tx.try_send(());
    }
}

fn suppressed() -> bool {
    SUPPRESSION.load(Ordering::SeqCst) > 0
}

/// 启动自动同步任务（lib.rs setup 调用一次）。
pub fn start_auto_sync(app: AppHandle) {
    let (tx, rx) = mpsc::channel(1);
    if DIRTY_TX.set(tx).is_err() {
        return;
    }
    tauri::async_runtime::spawn(run_auto_sync(app, rx));
}

async fn run_auto_sync(app: AppHandle, mut rx: mpsc::Receiver<()>) {
    loop {
        // 空闲时阻塞在这里，第一个脏信号开启一个防抖窗口。
        if rx.recv().await.is_none() {
            return;
        }

        let cap = tokio::time::sleep(MAX_WAIT);
        tokio::pin!(cap);
        loop {
            tokio::select! {
                // 静默满 DEBOUNCE：窗口内的所有变更合并成下面这一次上传。
                _ = tokio::time::sleep(DEBOUNCE) => break,
                // 一直有新变更时也不能无限等。
                _ = &mut cap => break,
                signal = rx.recv() => {
                    if signal.is_none() {
                        return;
                    }
                }
            }
        }

        auto_sync_once(&app).await;
    }
}

async fn auto_sync_once(app: &AppHandle) {
    // 防抖期间用户可能开始了手动下载，这里再确认一次。
    //
    // 直接 return 会丢掉这次已经被 `rx.recv()` 消费掉的脏信号（通道容量 1，
    // 且抑制期内 `mark_dirty` 是空操作，不会有新信号补进来），于是抑制窗口里
    // 攒下的所有本地改动永远等不到下一次上传。补一次标脏：此刻 SUPPRESSION
    // 尚未归零，`mark_dirty` 仍会被挡掉，所以要绕过它直接投递。
    //
    // 代价是抑制期间这里每 DEBOUNCE（1s）空转一次，直到守卫释放。下载是秒级
    // 操作，多几次纯内存的重投递不值得为它引入条件变量之类的额外机制。
    if suppressed() {
        if let Some(tx) = DIRTY_TX.get() {
            let _ = tx.try_send(());
        }
        return;
    }

    match auto_upload_backup_snapshot().await {
        // 未开启自动同步或凭据不全，静默跳过，不打扰用户。
        Ok(None) => {}
        Ok(Some(last_sync_at)) => emit_status(
            app,
            AutoSyncStatus {
                last_sync_at: Some(last_sync_at),
                last_error: None,
            },
        ),
        // 自动同步失败不能阻塞任何操作，只推事件让 UI 显示横幅。
        Err(error) => emit_status(
            app,
            AutoSyncStatus {
                last_sync_at: None,
                last_error: Some(error),
            },
        ),
    }
}

fn emit_status(app: &AppHandle, status: AutoSyncStatus) {
    if let Err(error) = app.emit(STATUS_EVENT, status) {
        eprintln!("failed to emit backup sync status: {error}");
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn backup_load_sync_config() -> Result<BackupSyncConfigView, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(load_backup_sync_config()?.into()))
        .await
        .map_err(|e| format!("backup_load_sync_config join 失败：{e}"))?
}

#[tauri::command]
pub async fn backup_save_sync_config(config: BackupSyncConfigRequest) -> Result<BackupSyncConfigView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let persisted = load_backup_sync_config()?;
        let resolved = resolve_backup_sync_config(config, &persisted);
        persist_backup_sync_config(&resolved)?;
        Ok(resolved.into())
    })
    .await
    .map_err(|e| format!("backup_save_sync_config join 失败：{e}"))?
}

/// 测试连接。用盘上已保存的配置，因此前端须先保存再测试。
#[tauri::command]
pub async fn backup_test_sync_connection() -> Result<(), String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config)
        .await
        .map_err(|e| format!("backup_test_sync_connection join 失败：{e}"))??;
    let creds = backup_credentials(&config)?;
    webdav::test_connection(&creds).await
}

/// 拉取远端摘要。远端还没有备份时返回 None。
#[tauri::command]
pub async fn backup_fetch_remote_info() -> Result<Option<BackupRemoteInfo>, String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config)
        .await
        .map_err(|e| format!("backup_fetch_remote_info join 失败：{e}"))??;
    let creds = backup_credentials(&config)?;
    let _guard = backup_sync_mutex().lock().await;

    let segments = backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME);
    let Some(body) = webdav::get_bytes(&creds, &segments, WEBDAV_MANIFEST_MAX_BYTES, "远端备份元信息").await?
    else {
        return Ok(None);
    };

    let remote = parse_backup_remote_manifest(&body)?;
    Ok(Some(BackupRemoteInfo {
        manifest: remote.manifest,
        size: remote.size,
        sha256: remote.sha256,
    }))
}

/// 下载：拉 manifest → 拉 config → 校验 size+sha256 → 应用快照。
///
/// **全程持有全局锁**，应用快照也在锁内。应用要跨多个配置域分别写文件，
/// 中间态是不自洽的；若此时自动上传拿到锁开始采集快照，传上去的
/// 就是半旧半新的配置。抑制守卫在锁内获取、随 blocking 任务一同释放。
#[tauri::command]
pub async fn backup_download() -> Result<BackupApplyOutcome, String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config)
        .await
        .map_err(|e| format!("backup_download join 失败：{e}"))??;
    let creds = backup_credentials(&config)?;

    let _guard = backup_sync_mutex().lock().await;

    let Some(manifest_body) =
        webdav::get_bytes(&creds, &backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME), WEBDAV_MANIFEST_MAX_BYTES, "远端备份元信息")
            .await?
    else {
        return Err("远端还没有备份，请先在任一设备上传一次".to_string());
    };
    // parse 时已校验 manifest 的版本兼容性，不兼容会在这里中止。
    let remote = parse_backup_remote_manifest(&manifest_body)?;

    let Some(body) =
        webdav::get_bytes(&creds, &backup_remote_file_segments(&config, WEBDAV_CONFIG_FILENAME), WEBDAV_CONFIG_MAX_BYTES, "远端配置")
            .await?
    else {
        return Err("远端元信息存在但配置文件缺失，请从源设备重新上传一次".to_string());
    };
    verify_backup_payload(&body, remote.size, &remote.sha256)?;
    let document = String::from_utf8(body).map_err(|_| "远端配置不是合法的 UTF-8 文本".to_string())?;

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        // 应用快照会改写各配置域文件。不抑制就会把刚拉下来的远端数据原样推回去。
        let _suppression = suppress();
        let (snapshot, _) = parse_backup_document(&document)?;
        let outcome = apply_backup_snapshot(snapshot)?;
        // 时间戳写失败**不能**推翻已经落盘的还原。快照此刻已经写完，
        // 这里再返回 Err 会让前端走 catch 分支：还原提示变成错误提示，
        // 且负责重载前端 store 的监听不会执行 —— 内存里仍是还原前的旧配置，
        // 下次编辑任一域就把它整个写回盘，用户看到的是「还原报错了，配置也
        // 确实没变」，而盘已经被改了。last_sync_at 只是展示用的元信息，
        // 丢一次远不如丢掉还原结果严重。
        let _ = touch_backup_last_sync_at();
        Ok::<_, String>(outcome)
    })
    .await
    .map_err(|e| format!("backup_download join 失败：{e}"))??;

    // 通知前端重载各配置域内存态（providers / MCP / hubSettings / 助手 / settings）。
    if let Some(handle) = SINGLE_APP_HANDLE.get() {
        let _ = handle.emit(APPLIED_EVENT, outcome.backup_path.clone());
    }
    Ok(outcome)
}

static SINGLE_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// setup 时注册全局句柄（发 backup:applied 事件用）。
pub fn register_app_handle(app: AppHandle) {
    let _ = SINGLE_APP_HANDLE.set(app);
}

/// 手动上传。
#[tauri::command]
pub async fn backup_upload() -> Result<i64, String> {
    upload_backup_snapshot().await
}

/// 前端标脏入口：配置保存动作完成后调用（provider/MCP/助手/技能/系统默认）。
#[tauri::command]
pub async fn backup_mark_dirty() -> Result<(), String> {
    mark_dirty();
    Ok(())
}

/// 导出到本地文件（前端已经 fs_pick_save_path 拿到目标路径）。
/// 与 WebDAV 上传同一采集/序列化链路，manifest 内联，单文件自包含。
#[tauri::command]
pub async fn backup_export_to_file(path: String) -> Result<BackupManifest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.trim().is_empty() {
            return Err("导出路径为空".to_string());
        }
        let snapshot = collect_backup_snapshot()?;
        let manifest = build_backup_manifest(&snapshot);
        let document = serialize_backup_document(&snapshot, &manifest)?;
        std::fs::write(&path, document).map_err(|e| format!("写入导出文件失败：{e}"))?;
        Ok(manifest)
    })
    .await
    .map_err(|e| format!("backup_export_to_file join 失败：{e}"))?
}

/// 导入文件大小上限（与 WebDAV 下载同一口径）。
const BACKUP_IMPORT_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// 导入预览：解析+校验成功但尚未写盘，供确认对话框展示。
/// 只读文件，不动任何配置。
#[tauri::command]
pub async fn backup_import_preview(path: String) -> Result<BackupRemoteInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let metadata =
            std::fs::metadata(&path).map_err(|e| format!("读取导入文件失败：{e}"))?;
        if metadata.len() > BACKUP_IMPORT_MAX_BYTES {
            return Err(format!(
                "导入文件过大（{} 字节），上限为 {BACKUP_IMPORT_MAX_BYTES} 字节",
                metadata.len()
            ));
        }
        let text = std::fs::read_to_string(&path).map_err(|e| format!("读取导入文件失败：{e}"))?;
        // parse 即校验（manifest 版本门 + 结构校验），预览阶段不落盘。
        let (snapshot, manifest) = crate::backup_snapshot::parse_backup_document(&text)?;
        drop(snapshot);
        let raw = serde_json::to_vec(&manifest).map_err(|e| format!("序列化元信息失败：{e}"))?;
        Ok(BackupRemoteInfo {
            manifest,
            // size/sha256 是 WebDAV manifest 的传输校验字段，文件导入用不上；
            // 填文件实际大小保持结构复用。
            size: raw.len(),
            sha256: backup_sha256_hex(&raw),
        })
    })
    .await
    .map_err(|e| format!("backup_import_preview join 失败：{e}"))?
}

/// 从本地文件导入应用（前端确认后调用）。校验 → 备份当前配置 → 写盘 →
/// emit backup:applied（前端重载各域内存态，与 WebDAV 下载同一链路）。
#[tauri::command]
pub async fn backup_import_from_file(path: String) -> Result<BackupApplyOutcome, String> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let metadata =
            std::fs::metadata(&path).map_err(|e| format!("读取导入文件失败：{e}"))?;
        if metadata.len() > BACKUP_IMPORT_MAX_BYTES {
            return Err(format!(
                "导入文件过大（{} 字节），上限为 {BACKUP_IMPORT_MAX_BYTES} 字节",
                metadata.len()
            ));
        }
        let text = std::fs::read_to_string(&path).map_err(|e| format!("读取导入文件失败：{e}"))?;
        let (snapshot, _) = crate::backup_snapshot::parse_backup_document(&text)?;
        // 导入是显式恢复动作：全程抑制自动上传标脏（与 WebDAV 下载同语义），
        // 应用前自动备份当前配置。
        let _suppression = suppress();
        crate::backup_snapshot::apply_backup_snapshot(snapshot)
    })
    .await
    .map_err(|e| format!("backup_import_from_file join 失败：{e}"))??;

    if let Some(handle) = SINGLE_APP_HANDLE.get() {
        let _ = handle.emit(APPLIED_EVENT, outcome.backup_path.clone());
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_remote_path_strips_traversal() {
        assert_eq!(sanitize_remote_path("a/b"), "a/b");
        assert_eq!(sanitize_remote_path("/a//b/"), "a/b");
        assert_eq!(sanitize_remote_path("../../etc"), "etc");
        assert_eq!(sanitize_remote_path(".."), "");
        assert_eq!(sanitize_remote_path(" . / a "), "a");
    }

    #[test]
    fn resolve_keeps_old_password_when_untouched() {
        let persisted = BackupSyncConfig {
            url: "https://dav.example.com".into(),
            username: "alice".into(),
            password: "real-secret".into(),
            ..Default::default()
        };
        let request = BackupSyncConfigRequest {
            url: "https://dav.example.com/".into(),
            username: "alice".into(),
            password: "••••••".into(),
            password_touched: false,
            remote_dir: "reinagent".into(),
            profile: "default".into(),
            auto_sync: true,
        };
        let resolved = resolve_backup_sync_config(request.clone(), &persisted);
        assert_eq!(resolved.password, "real-secret", "未触碰的密码框不得覆盖旧密码");
        assert_eq!(resolved.url, "https://dav.example.com");
        assert!(resolved.auto_sync);
        // 触碰后用新值。
        let request = BackupSyncConfigRequest {
            password: "new-secret".into(),
            password_touched: true,
            ..request
        };
        let resolved = resolve_backup_sync_config(request, &persisted);
        assert_eq!(resolved.password, "new-secret");
    }

    #[test]
    fn view_never_contains_password() {
        let config = BackupSyncConfig {
            password: "secret".into(),
            ..Default::default()
        };
        let view = BackupSyncConfigView::from(config);
        assert!(view.has_password);
        // BackupSyncConfigView 没有密码字段（编译期保证），这里防未来回归。
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("secret"), "{json}");
    }

    #[test]
    fn export_import_roundtrip_via_file() {
        // 真实链路：serialize → 写临时文件 → 读回 parse → 快照一致。
        let snapshot = crate::backup_snapshot::BackupSnapshot {
            providers: Some(serde_json::json!([
                {"id": "deepseek", "name": "DeepSeek", "baseUrl": "https://api.deepseek.com"},
                {"id": "custom-1", "name": "GW", "baseUrl": "http://gw:1"}
            ])),
            mcp: Some(serde_json::json!([{"id": "docs", "enabled": true}])),
            assistants: Some(serde_json::json!([
                {"id": "coder", "name": "coder.md", "content": "---\nname: coder\nmodel: custom-1/m\n---\nbody"}
            ])),
            skills_selection: Some(serde_json::json!(["browser-use"])),
            system: Some(serde_json::json!({"provider": "custom-1", "modelId": "m", "apiKey": "sk-x", "baseUrl": "http://gw:1"})),
        };
        let manifest = crate::backup_snapshot::build_backup_manifest(&snapshot);
        let document = crate::backup_snapshot::serialize_backup_document(&snapshot, &manifest).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("export.json");
        std::fs::write(&path, &document).unwrap();

        let metadata = std::fs::metadata(&path).unwrap();
        assert!(metadata.len() <= BACKUP_IMPORT_MAX_BYTES);
        let text = std::fs::read_to_string(&path).unwrap();
        let (parsed, parsed_manifest) = crate::backup_snapshot::parse_backup_document(&text).unwrap();
        assert_eq!(parsed_manifest.snapshot_id, manifest.snapshot_id);
        assert_eq!(parsed.providers, snapshot.providers);
        assert_eq!(parsed.system, snapshot.system);
        assert_eq!(parsed.assistants, snapshot.assistants);
    }

    #[test]
    fn import_rejects_oversized_and_garbage() {
        let dir = tempfile::tempdir().unwrap();
        // 超限文件。
        let big = dir.path().join("big.json");
        std::fs::write(&big, vec![b'x'; (BACKUP_IMPORT_MAX_BYTES + 1) as usize]).unwrap();
        assert!(std::fs::metadata(&big).unwrap().len() > BACKUP_IMPORT_MAX_BYTES);
        // 非 JSON 垃圾。
        let junk = dir.path().join("junk.json");
        std::fs::write(&junk, "not a backup").unwrap();
        let text = std::fs::read_to_string(&junk).unwrap();
        assert!(crate::backup_snapshot::parse_backup_document(&text).is_err());
        // 合法 JSON 但缺 manifest。
        let empty = dir.path().join("empty.json");
        std::fs::write(&empty, "{}").unwrap();
        let text = std::fs::read_to_string(&empty).unwrap();
        assert!(crate::backup_snapshot::parse_backup_document(&text).is_err());
    }

    #[test]
    fn verify_payload_rejects_missing_or_mismatched() {
        let body = b"hello backup";
        let sha = backup_sha256_hex(body);
        assert!(verify_backup_payload(body, body.len(), &sha).is_ok());
        // 缺摘要：拒。
        assert!(verify_backup_payload(body, body.len(), "").is_err());
        // 大小不符：拒。
        assert!(verify_backup_payload(body, body.len() - 1, &sha).is_err());
        // 摘要不符：拒。
        assert!(verify_backup_payload(body, body.len(), "deadbeef").is_err());
    }

    #[test]
    fn suppression_is_reference_counted_and_gates_dirty_marks() {
        assert!(!suppressed(), "初始状态不应处于抑制期");

        let outer = suppress();
        assert!(suppressed());
        // 抑制期内标脏必须无效，否则应用远端快照会立刻把数据推回远端。
        mark_dirty();

        {
            let _inner = suppress();
            assert!(suppressed());
        }
        // 内层释放不能提前解除外层的抑制。
        assert!(suppressed(), "仍有外层 guard 存活时必须保持抑制");

        drop(outer);
        assert!(!suppressed(), "全部 guard 释放后应恢复标脏");
    }

    #[test]
    fn dirty_channel_coalesces_bursts_into_one_signal() {
        let (tx, mut rx) = mpsc::channel::<()>(1);
        for _ in 0..5 {
            let _ = tx.try_send(());
        }
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err(), "5 次变更只应留下 1 个待处理信号");
    }
}
