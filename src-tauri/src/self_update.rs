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

/// 清理上次更新留下的 `<exe>.old`（仍被占用则留待下次）与重复的 `<exe>.new`。
/// 在 setup 里调用（此时新进程已就位，旧 exe 一般已退出）。
pub fn cleanup_stale() {
    if let Ok(exe) = current_exe() {
        let _ = std::fs::remove_file(old_path_str(&exe));
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
    // 上次下载失败/中断留下的 .new
    if let Ok(exe) = current_exe() {
        let _ = std::fs::remove_file(new_path(&exe));
    }
}

fn new_path(exe: &Path) -> PathBuf {
    let mut s = exe.as_os_str().to_os_string();
    s.push(".new");
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

fn build_client() -> Result<reqwest::Client, String> {
    let (proxy_url, no_proxy) = crate::app_proxy::read_proxy_settings();
    let mut builder = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(20));
    let proxy_trimmed = proxy_url.trim();
    if !proxy_trimmed.is_empty() {
        let mut proxy = reqwest::Proxy::all(proxy_trimmed)
            .map_err(|e| format!("代理配置无效（kv reinagent-web-proxy = {proxy_trimmed}）：{e}"))?;
        if !no_proxy.trim().is_empty() {
            proxy = proxy.no_proxy(reqwest::NoProxy::from_string(no_proxy.trim()));
        }
        builder = builder.proxy(proxy);
    } else {
        // 与 llm_proxy 一致：留空 = 显式直连（不静默跟随环境代理）
        builder = builder.no_proxy();
    }
    builder.build().map_err(|e| format!("更新客户端构建失败：{e}"))
}

// ---------------- 命令 ----------------

#[derive(Deserialize)]
pub struct UpdateArgs {
    /// feed URL；留空用 DEFAULT_FEED。
    pub feed: Option<String>,
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
    let client = build_client()?;
    let feed = fetch_feed(&client, &feed_of(&args)).await?;
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
    client: &reqwest::Client,
    asset: &Asset,
    dest: &Path,
) -> Result<(), String> {
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
    let mut file = std::fs::File::create(dest).map_err(|e| format!("创建临时文件失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断：{e}"))? {
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|e| format!("写入临时文件失败：{e}"))?;
        written += chunk.len() as u64;
    }
    file.flush().map_err(|e| format!("落盘失败：{e}"))?;
    drop(file);

    let got = hex(&hasher.finalize());
    let want = asset.sha256.trim().to_ascii_lowercase();
    if !want.is_empty() && got != want {
        let _ = std::fs::remove_file(dest);
        return Err(format!("SHA-256 校验失败（期望 {want}，实际 {got}）"));
    }
    if asset.size > 0 && written != asset.size {
        let _ = std::fs::remove_file(dest);
        return Err(format!(
            "文件大小不符（期望 {} 字节，实际 {written} 字节）",
            asset.size
        ));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
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

/// 下载并安装更新，成功后重启应用（不返回）。
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, args: UpdateArgs) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    let client = build_client()?;
    let feed = fetch_feed(&client, &feed_of(&args)).await?;
    if !is_newer(&feed.version, &current) {
        return Err("当前已是最新版本".to_string());
    }
    let name = asset_name();
    let asset = feed
        .assets
        .get(&name)
        .ok_or_else(|| format!("更新源缺少本机所需文件：{name}"))?;

    if cfg!(target_os = "macos") {
        install_macos(&app, &client, asset).await?;
    } else {
        install_binary(&client, asset).await?;
    }
    app.restart();
    #[allow(unreachable_code)]
    Ok(())
}

/// 裸二进制（Windows/Linux）：下到同目录 .new → 校验 → 替换（Windows 先移走旧的）。
async fn install_binary(client: &reqwest::Client, asset: &Asset) -> Result<(), String> {
    let exe = current_exe()?;
    if !writable(exe.parent().unwrap_or(Path::new("."))) {
        return Err(format!(
            "无法写入程序所在目录（{}），请以管理员身份运行或用安装位置可写的副本更新",
            exe.display()
        ));
    }
    let staged = new_path(&exe);
    let _ = std::fs::remove_file(&staged);
    download_to(client, asset, &staged).await?;
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
    _app: &tauri::AppHandle,
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
    download_to(client, asset, &zip).await?;

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
}
