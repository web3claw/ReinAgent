//! 应用自更新（照搬 magpie 的更新模型，2026-10-08）。
//!
//! 与 tauri-plugin-updater 的差异（本项目刻意不用它）：插件只会下载**安装包**再交给
//! 系统安装器；本项目 Windows/Linux 分发的是**裸二进制**、macOS 分发 `.app` zip，
//! 所以必须自己做「下载 → 校验 → 原地替换」——这正是 magpie 的做法。
//!
//! - **更新源**：自建 `latest.json`（Release asset），格式对齐 magpie 的 feed：
//!   `{ version, notes, pub_date, assets: { 文件名: { url, size, sha256 } } }`。
//! - **完整性**：仅 SHA-256（与 magpie 裸二进制一致；其 macOS 另有 codesign 校验，
//!   本项目未签名故略去）。
//! - **裸二进制替换**：下到同目录 `<exe>.new` → 校验 → 替换。Windows 上运行中的 exe
//!   不能覆盖但可**改名移走**，故先 `rename(exe → exe.old)` 再 `rename(.new → exe)`；
//!   Linux 直接原子 rename。失败即回滚。
//! - **macOS**：下载 `.app` zip → 解压到暂存 → `rename(bundle → old.app)` →
//!   `rename(staged → bundle)`。
//! - **旧文件清理**：Windows 的 `.old` 在被进程占用期间删不掉，留到**下次启动**清理
//!   （`cleanup_stale`，在 setup 里调用）。
//!
//! 所有失败如实上抛，绝不伪装成功（No-Fallback）。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 更新源（Release 的 latest.json，静态、无限流）。
pub const DEFAULT_FEED: &str =
    "https://github.com/web3claw/ReinAgent/releases/latest/download/latest.json";

// ---------------- feed 结构（对齐 magpie） ----------------

#[derive(Debug, Clone, Deserialize)]
struct Asset {
    url: String,
    #[serde(default)]
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Feed {
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    pub_date: Option<String>,
    #[serde(default)]
    assets: std::collections::HashMap<String, Asset>,
}

// ---------------- 前端可见结果 ----------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pub_date: Option<String>,
}

/// 下载进度通知负载（前端监听 "update-progress" 事件）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressPayload {
    pub percent: u32,
    pub downloaded: u64,
    pub total: u64,
}

// ---------------- 平台/产物命名 ----------------

fn arch_tag() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    }
}

/// 本机该下载的 asset 文件名（与 CI 产物命名一一对应）。
/// - macOS：`ReinAgent-darwin-{arch}.zip`（.app 压缩包，自更新用）
/// - Windows：`ReinAgent-windows-{arch}.exe`（裸二进制）
/// - Linux：`ReinAgent-linux-{arch}`（裸二进制）
fn asset_name() -> String {
    if cfg!(target_os = "macos") {
        format!("ReinAgent-darwin-{}.zip", arch_tag())
    } else if cfg!(target_os = "windows") {
        format!("ReinAgent-windows-{}.exe", arch_tag())
    } else {
        format!("ReinAgent-linux-{}", arch_tag())
    }
}

// ---------------- 版本比较（简易语义化版本，支持预发布与 build 元数据） ----------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Semver {
    nums: Vec<u64>,
    pre: String,
}

fn parse_version(s: &str) -> Option<Semver> {
    let s = s.trim().trim_start_matches('v');
    if s.is_empty() {
        return None;
    }
    // 去掉 build 元数据 +x
    let core = s.split('+').next().unwrap_or(s);
    let (nums_part, pre) = match core.split_once('-') {
        Some((n, p)) => (n, p.to_string()),
        None => (core, String::new()),
    };
    let mut nums = Vec::new();
    for part in nums_part.split('.') {
        // 容忍 "0beta" 之类：取前导数字
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        nums.push(digits.parse().ok()?);
    }
    if nums.is_empty() {
        return None;
    }
    Some(Semver { nums, pre })
}

/// a 是否比 b 新。预发布（有 `-pre`）早于同号正式版。
fn is_newer(a: &str, b: &str) -> bool {
    let (Some(x), Some(y)) = (parse_version(a), parse_version(b)) else {
        return false;
    };
    let n = x.nums.len().max(y.nums.len());
    for i in 0..n {
        let xa = x.nums.get(i).copied().unwrap_or(0);
        let ya = y.nums.get(i).copied().unwrap_or(0);
        if xa != ya {
            return xa > ya;
        }
    }
    // 数字相同：正式版 > 预发布
    match (x.pre.is_empty(), y.pre.is_empty()) {
        (true, false) => true,
        (false, true) => false,
        _ => x.pre > y.pre,
    }
}

// ---------------- 路径工具 ----------------

/// 运行中的可执行文件（解析符号链接）。
pub fn current_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位当前可执行文件：{e}"))?;
    Ok(std::fs::canonicalize(&exe).unwrap_or(exe))
}

/// macOS 的 .app 目录（不在 bundle 内则 None）。
/// 结构：…/ReinAgent.app/Contents/MacOS/ReinAgent
pub fn macos_bundle() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let exe = current_exe().ok()?;
    let macos_dir = exe.parent()?;
    let contents = macos_dir.parent()?;
    let app = contents.parent()?;
    if app.extension().map(|e| e == "app").unwrap_or(false)
        && macos_dir.file_name().map(|n| n == "MacOS").unwrap_or(false)
    {
        Some(app.to_path_buf())
    } else {
        None
    }
}

// ---------------- 启动时清理上次遗留（Windows 关键） ----------------

/// 清理上次更新留下的 `<exe>.old`（仍被占用则留待下次）与重复的 `<exe>.new`、`.part`。
/// 在 setup 里调用（此时新进程已就位，旧 exe 一般已退出）。
pub fn cleanup_stale() {
    if let Ok(exe) = current_exe() {
        let _ = std::fs::remove_file(old_path_str(&exe));
        let _ = std::fs::remove_file(new_path(&exe));
        let _ = std::fs::remove_file(part_path(&new_path(&exe)));
        let _ = std::fs::remove_file(part_path(&exe));
        // .old-2、.old-3…
        if let (Some(dir), Some(name)) = (exe.parent(), exe.file_name().and_then(|s| s.to_str())) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                let prefix = format!("{name}.old-");
                for entry in entries.flatten() {
                    let fname = entry.file_name();
                    if fname.to_string_lossy().starts_with(&prefix) {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
    }
}

fn new_path(exe: &Path) -> PathBuf {
    let mut s = exe.as_os_str().to_os_string();
    s.push(".new");
    PathBuf::from(s)
}

fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(".part");
    PathBuf::from(s)
}

/// `<exe>.old`，已存在（在用）时顺延 `.old-2`、`.old-3`…（同 magpie 的 oldName）。
fn old_path_str(exe: &Path) -> PathBuf {
    let base = {
        let mut s = exe.as_os_str().to_os_string();
        s.push(".old");
        PathBuf::from(s)
    };
    if !base.exists() {
        return base;
    }
    for n in 2..1000 {
        let mut s = exe.as_os_str().to_os_string();
        s.push(format!(".old-{n}"));
        let p = PathBuf::from(s);
        if !p.exists() {
            return p;
        }
    }
    base
}

// ---------------- HTTP ----------------

/// 构建更新用的 HTTP 客户端（每个目标 URL 一个）。
///
/// 代理语义与设置页（kv `reinagent-web-proxy` / `-no-proxy`）完全一致：
/// - 未配置代理 → 显式直连（不静默跟随系统/环境变量代理，对齐 app_proxy 语义）；
/// - 已配置代理 → 走代理；但目标 URL 命中 no-proxy 规则时该请求直连。
///
/// reqwest 的 `Proxy` 无 per-request 开关，故按 URL 是否命中 no-proxy 决定用哪种
/// 客户端——命中直连的 URL（如自建镜像/内网）不会被送去代理。
fn build_client(for_url: &str) -> Result<reqwest::Client, String> {
    let (proxy_url, _no_proxy) = crate::app_proxy::read_proxy_settings();
    let proxy_trimmed = proxy_url.trim();
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(600));

    let bypass = crate::web_tools::url_bypasses_proxy(for_url);
    if proxy_trimmed.is_empty() || bypass {
        // 「留空直连」语义：显式禁用一切代理（含环境变量）
        builder = builder.no_proxy();
    } else {
        let proxy = reqwest::Proxy::all(proxy_trimmed)
            .map_err(|e| format!("代理配置无效（kv reinagent-web-proxy = {proxy_trimmed}）：{e}"))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| format!("更新客户端构建失败：{e}"))
}

// ---------------- 命令 ----------------

#[derive(Deserialize)]
pub struct UpdateArgs {
    /// feed URL；留空用 DEFAULT_FEED。
    pub feed: Option<String>,
    /// 是否延后重启（用于自动静默下载完成后等待用户手动确认再重启）
    pub defer_restart: Option<bool>,
}

fn feed_of(args: &UpdateArgs) -> String {
    args.feed
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_FEED)
        .to_string()
}

async fn fetch_feed(client: &reqwest::Client, url: &str) -> Result<Feed, String> {
    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("拉取更新源失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("拉取更新源失败：HTTP {}", resp.status()));
    }
    let feed: Feed = resp
        .json()
        .await
        .map_err(|e| format!("更新源 JSON 解析失败：{e}"))?;
    if parse_version(&feed.version).is_none() {
        return Err("更新源缺少有效 version".to_string());
    }
    Ok(feed)
}

/// 检查更新（不下载）。
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle, args: UpdateArgs) -> Result<UpdateCheckResult, String> {
    let current = app.package_info().version.to_string();
    let feed_url = feed_of(&args);
    let client = build_client(&feed_url)?;
    let feed = fetch_feed(&client, &feed_url).await?;
    if is_newer(&feed.version, &current) {
        Ok(UpdateCheckResult {
            has_update: true,
            current_version: current,
            available_version: Some(feed.version.clone()),
            notes: Some(feed.notes.clone()),
            pub_date: feed.pub_date.clone(),
        })
    } else {
        Ok(UpdateCheckResult {
            has_update: false,
            current_version: current,
            available_version: None,
            notes: None,
            pub_date: None,
        })
    }
}

async fn download_to(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    asset: &Asset,
    dest: &Path,
) -> Result<(), String> {
    use tauri::Emitter;

    let part = part_path(dest);
    let _ = std::fs::remove_file(&part);

    let mut resp = client
        .get(&asset.url)
        .send()
        .await
        .map_err(|e| format!("下载更新包失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载更新包失败：HTTP {}", resp.status()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建下载目录失败：{e}"))?;
    }
    let mut file = std::fs::File::create(&part).map_err(|e| format!("创建临时下载文件失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let total = if asset.size > 0 {
        asset.size
    } else {
        resp.content_length().unwrap_or(0)
    };

    let mut last_emit = std::time::Instant::now();
    let mut last_percent = 0u32;

    // 初始 0% 进度通知
    let _ = app.emit(
        "update-progress",
        UpdateProgressPayload {
            percent: 0,
            downloaded: 0,
            total,
        },
    );

    loop {
        // 单 chunk 读取 30 秒超时保护（防止连接假死）
        let chunk_res = tokio::time::timeout(std::time::Duration::from_secs(30), resp.chunk()).await;
        let chunk = match chunk_res {
            Ok(Ok(Some(c))) => c,
            Ok(Ok(None)) => break,
            Ok(Err(e)) => {
                let _ = std::fs::remove_file(&part);
                return Err(format!("下载数据流中断：{e}"));
            }
            Err(_) => {
                let _ = std::fs::remove_file(&part);
                return Err("下载数据块读取超时（30秒未收到数据包）".to_string());
            }
        };

        hasher.update(&chunk);
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(&part);
            return Err(format!("写入临时下载文件失败：{e}"));
        }
        written += chunk.len() as u64;

        let percent = if total > 0 {
            ((written as f64 / total as f64) * 100.0).clamp(0.0, 100.0) as u32
        } else {
            0
        };

        // 限频派发更新进度（至少间隔 80ms 或百分比变化）
        if percent != last_percent
            && (last_emit.elapsed() >= std::time::Duration::from_millis(80) || percent == 100)
        {
            last_percent = percent;
            last_emit = std::time::Instant::now();
            let _ = app.emit(
                "update-progress",
                UpdateProgressPayload {
                    percent,
                    downloaded: written,
                    total,
                },
            );
        }
    }

    if let Err(e) = file.flush() {
        let _ = std::fs::remove_file(&part);
        return Err(format!("落盘失败：{e}"));
    }
    drop(file);

    let got = hex(&hasher.finalize());
    let want = asset.sha256.trim().to_ascii_lowercase();
    if !want.is_empty() && got != want {
        let _ = std::fs::remove_file(&part);
        return Err(format!("SHA-256 校验失败（期望 {want}，实际 {got}）"));
    }
    if asset.size > 0 && written != asset.size {
        let _ = std::fs::remove_file(&part);
        return Err(format!(
            "文件大小不符（期望 {} 字节，实际 {written} 字节）",
            asset.size
        ));
    }

    // 裸二进制格式合法性预检（防止截断损坏或错误产物）
    if !dest.extension().map(|e| e == "zip").unwrap_or(false) {
        if let Err(e) = verify_executable_binary(&part) {
            let _ = std::fs::remove_file(&part);
            return Err(format!("二进制合法性预检失败：{e}"));
        }
    }

    // 预检全部通过，原子重命名至目标路径
    std::fs::rename(&part, dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("完成下载临时文件转正失败：{e}")
    })?;

    // 派发 100% 结束进度
    let _ = app.emit(
        "update-progress",
        UpdateProgressPayload {
            percent: 100,
            downloaded: written,
            total: if total > 0 { total } else { written },
        },
    );

    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 对下载完成的裸二进制文件进行文件格式与段表完整性预检。
/// - Linux: 校验 ELF 魔数及 64 位段表（Section Header Table）尾部偏移是否超出文件大小；
/// - Windows: 校验 MZ 头部及 PE 签名。
pub fn verify_executable_binary(path: &Path) -> Result<(), String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("无法读取可执行文件进行预检：{e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("获取文件元数据失败：{e}"))?;
    let file_len = metadata.len();

    if cfg!(target_os = "linux") {
        if file_len < 64 {
            return Err(format!("Linux ELF 二进制过小（仅 {file_len} 字节）"));
        }
        let mut header = [0u8; 64];
        file.read_exact(&mut header)
            .map_err(|e| format!("读取 ELF 头部失败：{e}"))?;

        if &header[0..4] != b"\x7fELF" {
            return Err("文件缺少 Linux ELF 魔数头部，不是合法的 Linux 二进制".to_string());
        }

        // 仅在 64 位 ELF (EI_CLASS = 2) 且小端 (EI_DATA = 1) 时深度校验段表偏移
        if header[4] == 2 && header[5] == 1 {
            let e_shoff = u64::from_le_bytes(header[40..48].try_into().unwrap());
            let e_shentsize = u16::from_le_bytes(header[58..60].try_into().unwrap()) as u64;
            let e_shnum = u16::from_le_bytes(header[60..62].try_into().unwrap()) as u64;

            if e_shoff > 0 && e_shnum > 0 {
                let table_end = e_shoff
                    .checked_add(e_shentsize.saturating_mul(e_shnum))
                    .ok_or_else(|| "ELF 段表偏移计算溢出".to_string())?;
                if table_end > file_len {
                    return Err(format!(
                        "ELF 段表越界截断（需要至少 {table_end} 字节，文件实际仅 {file_len} 字节）"
                    ));
                }
            }
        }
    } else if cfg!(target_os = "windows") {
        if file_len < 64 {
            return Err(format!("Windows PE 可执行文件过小（仅 {file_len} 字节）"));
        }
        let mut header = [0u8; 64];
        file.read_exact(&mut header)
            .map_err(|e| format!("读取 PE DOS 头部失败：{e}"))?;

        if &header[0..2] != b"MZ" {
            return Err("文件缺少 Windows PE DOS 魔数（MZ），不是合法的 Windows 二进制".to_string());
        }

        let pe_offset = u32::from_le_bytes(header[0x3c..0x40].try_into().unwrap()) as u64;
        if pe_offset + 4 <= file_len {
            use std::io::Seek;
            if file.seek(std::io::SeekFrom::Start(pe_offset)).is_ok() {
                let mut pe_sig = [0u8; 4];
                if file.read_exact(&mut pe_sig).is_ok() && &pe_sig != b"PE\0\0" {
                    return Err("文件缺少 PE 签名（PE\\0\\0），PE 结构损坏".to_string());
                }
            }
        }
    }
    Ok(())
}

fn set_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| format!("读取权限失败：{e}"))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).map_err(|e| format!("设置可执行权限失败：{e}"))?;
    }
    Ok(())
}

/// 下载并安装更新，若未设置 defer_restart 则成功后自动重启应用。
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, args: UpdateArgs) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    let feed_url = feed_of(&args);
    let client = build_client(&feed_url)?;
    let feed = fetch_feed(&client, &feed_url).await?;
    if !is_newer(&feed.version, &current) {
        return Err("当前已是最新版本".to_string());
    }
    let name = asset_name();
    let asset = feed
        .assets
        .get(&name)
        .ok_or_else(|| format!("更新源缺少本机所需文件：{name}"))?;
    // 下载走 asset 自身 URL 的代理判定（可能与 feed URL 不同，如镜像/CDN）
    let dl_client = build_client(&asset.url)?;

    if cfg!(target_os = "macos") {
        install_macos(&app, &dl_client, asset).await?;
    } else {
        install_binary(&app, &dl_client, asset).await?;
    }
    if !args.defer_restart.unwrap_or(false) {
        app.restart();
    }
    Ok(())
}

/// 重启应用以使已安装的更新生效。
#[tauri::command]
pub async fn update_restart(app: tauri::AppHandle) -> Result<(), String> {
    app.restart();
    #[allow(unreachable_code)]
    Ok(())
}

/// 裸二进制（Windows/Linux）：下到同目录 .new → 校验 → 替换（Windows 先移走旧的）。
async fn install_binary(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    asset: &Asset,
) -> Result<(), String> {
    let exe = current_exe()?;
    if !writable(exe.parent().unwrap_or(Path::new("."))) {
        return Err(format!(
            "无法写入程序所在目录（{}），请以管理员身份运行或用安装位置可写的副本更新",
            exe.display()
        ));
    }
    let staged = new_path(&exe);
    let _ = std::fs::remove_file(&staged);
    download_to(app, client, asset, &staged).await?;
    set_executable(&staged)?;

    // Windows：运行中的 exe 不能覆盖，但可改名移走。
    let mut aside: Option<PathBuf> = None;
    if cfg!(target_os = "windows") {
        let old = old_path_str(&exe);
        std::fs::rename(&exe, &old).map_err(|e| {
            let _ = std::fs::remove_file(&staged);
            format!("无法移开正在运行的旧版本（{}）：{e}", old.display())
        })?;
        aside = Some(old);
    }

    if let Err(e) = std::fs::rename(&staged, &exe) {
        // 回滚：把旧版本改回去，避免程序消失
        if let Some(old) = &aside {
            let _ = std::fs::rename(old, &exe);
        }
        let _ = std::fs::remove_file(&staged);
        return Err(format!("替换可执行文件失败：{e}"));
    }
    Ok(())
}

/// macOS：下载 .app zip → 解压到暂存 → 换掉整个 bundle。
async fn install_macos(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    asset: &Asset,
) -> Result<(), String> {
    let bundle = macos_bundle()
        .ok_or_else(|| "当前不在 .app 包内运行，无法自更新".to_string())?;
    let work = bundle
        .parent()
        .ok_or_else(|| "无法定位 .app 所在目录".to_string())?
        .join(".ReinAgent-update");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| format!("创建暂存目录失败：{e}"))?;

    let zip = work.join("app.zip");
    download_to(app, client, asset, &zip).await?;

    // 解压（zip crate 已在依赖内）
    let file = std::fs::File::open(&zip).map_err(|e| format!("打开更新包失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("更新包格式无效：{e}"))?;
    archive
        .extract(&work)
        .map_err(|e| format!("解压更新包失败：{e}"))?;
    drop(archive);

    // zip 内顶层应为 ReinAgent.app
    let staged = work.join("ReinAgent.app");
    if !staged.is_dir() {
        return Err("更新包内缺少 ReinAgent.app".to_string());
    }

    let old = work.join("old.app");
    let _ = std::fs::remove_dir_all(&old);
    std::fs::rename(&bundle, &old).map_err(|e| format!("移开旧版本失败：{e}"))?;
    if let Err(e) = std::fs::rename(&staged, &bundle) {
        let _ = std::fs::rename(&old, &bundle); // 回滚
        return Err(format!("替换应用包失败：{e}"));
    }
    Ok(())
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(".reinagent-update-probe");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_orders_correctly() {
        assert!(is_newer("1.2.0", "1.1.9"));
        assert!(is_newer("0.2.0", "0.1.2"));
        assert!(!is_newer("0.1.2", "0.1.2"));
        assert!(!is_newer("0.1.1", "0.1.2"));
        assert!(is_newer("1.0.0", "1.0.0-rc.1"));
        assert!(!is_newer("1.0.0-rc.1", "1.0.0"));
        assert!(is_newer("v1.3.0", "1.2.9"));
        assert!(is_newer("1.2.0+build.5", "1.1.0"));
    }

    #[test]
    fn asset_names_match_ci_convention() {
        let name = asset_name();
        assert!(name.starts_with("ReinAgent-"));
        // windows → .exe、macos → .zip、linux → 无扩展名
        assert!(name.ends_with(".exe") || name.ends_with(".zip") || !name.contains('.'));
    }

    /// 更新走公网 → 必须复用设置页的代理；no-proxy 规则命中则直连。
    #[test]
    fn proxy_bypass_rules_apply_to_update_urls() {
        // 默认 no-proxy（web_tools::KV_WEB_PROXY_NO_PROXY_DEFAULT）覆盖的地址应直连
        assert!(crate::web_tools::url_bypasses_proxy("http://127.0.0.1:7890/x"));
        assert!(crate::web_tools::url_bypasses_proxy("http://192.168.1.5/y"));
        // 公网地址不命中 → 应走代理
        assert!(!crate::web_tools::url_bypasses_proxy(
            "https://github.com/web3claw/ReinAgent/releases/download/v0.1.3/latest.json"
        ));
        // 非 http(s) 一律不当作代理目标
        assert!(!crate::web_tools::url_bypasses_proxy("file:///tmp/x"));
    }

    #[test]
    fn part_path_generation() {
        let p = PathBuf::from("/path/to/binary");
        assert_eq!(part_path(&p), PathBuf::from("/path/to/binary.part"));
    }

    #[test]
    fn verify_executable_binary_rejects_truncated_file() {
        let dir = std::env::temp_dir().join("reinagent_test_verify");
        let _ = std::fs::create_dir_all(&dir);
        let tiny_file = dir.join("tiny_binary");
        std::fs::write(&tiny_file, b"too small").unwrap();

        let res = verify_executable_binary(&tiny_file);
        assert!(res.is_err(), "应拒绝小于 64 字节的坏文件");
        let _ = std::fs::remove_file(&tiny_file);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn verify_executable_binary_detects_truncated_elf_section_table() {
        let dir = std::env::temp_dir().join("reinagent_test_verify");
        let _ = std::fs::create_dir_all(&dir);
        let elf_file = dir.join("truncated_elf");

        // 构造一个 64 字节的伪 ELF 头部：
        // 魔数 \x7fELF, EI_CLASS=2 (64-bit), EI_DATA=1 (little-endian)
        // e_shoff (40..48) = 1000, e_shentsize (58..60) = 64, e_shnum (60..62) = 10
        // 段表需要 1000 + 64 * 10 = 1640 字节，但文件只有 200 字节
        let mut data = vec![0u8; 200];
        data[0..4].copy_from_slice(b"\x7fELF");
        data[4] = 2; // 64-bit
        data[5] = 1; // little endian
        data[40..48].copy_from_slice(&1000u64.to_le_bytes());
        data[58..60].copy_from_slice(&64u16.to_le_bytes());
        data[60..62].copy_from_slice(&10u16.to_le_bytes());

        std::fs::write(&elf_file, &data).unwrap();
        let res = verify_executable_binary(&elf_file);
        assert!(res.is_err());
        let err_msg = res.unwrap_err();
        assert!(err_msg.contains("ELF 段表越界截断"));

        // 构造一个完整大小的 mock 文件：2000 字节，应顺利通过预检
        let mut valid_data = vec![0u8; 2000];
        valid_data[..200].copy_from_slice(&data);
        std::fs::write(&elf_file, &valid_data).unwrap();
        assert!(verify_executable_binary(&elf_file).is_ok());

        let _ = std::fs::remove_file(&elf_file);
    }
}

