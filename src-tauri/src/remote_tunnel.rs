//! 远程访问公网隧道管理模块（Cloudflare Quick Tunnel / 自定义公网地址）。
//!
//! 功能职责：
//! 1. 网络模式管理：局域网 (Lan) / Cloudflare 免费免配置公网隧道 (Cloudflare) / 用户自定义反代域名 (Custom)；
//! 2. `cloudflared` 二进制管理：优先检测系统环境，缺失时安全下载至 `~/.ReinAgent/bin/`；
//! 3. 隧道子进程生命周期：异步启动、日志监听、正则捕获公网 HTTPS 域名、异常重试与优雅退出。

use futures_util::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelNetworkMode {
    Lan,
    Cloudflare,
    Custom,
}

impl Default for TunnelNetworkMode {
    fn default() -> Self {
        Self::Lan
    }
}

#[allow(dead_code)]
impl TunnelNetworkMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Lan => "lan",
            Self::Cloudflare => "cloudflare",
            Self::Custom => "custom",
        }
    }

    pub fn from_str_opt(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "cloudflare" => Self::Cloudflare,
            "custom" => Self::Custom,
            _ => Self::Lan,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub mode: TunnelNetworkMode,
    /// "stopped" | "starting" | "running" | "error"
    pub status: String,
    pub public_url: Option<String>,
    pub error: Option<String>,
    pub progress: Option<String>,
}

impl Default for TunnelStatus {
    fn default() -> Self {
        Self {
            mode: TunnelNetworkMode::Lan,
            status: "stopped".to_string(),
            public_url: None,
            error: None,
            progress: None,
        }
    }
}

struct TunnelProcessState {
    status: TunnelStatus,
    child: Option<Child>,
    generation: u64,
}

impl Drop for TunnelProcessState {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

static TUNNEL_STATE: OnceLock<Mutex<TunnelProcessState>> = OnceLock::new();

fn state() -> &'static Mutex<TunnelProcessState> {
    TUNNEL_STATE.get_or_init(|| {
        Mutex::new(TunnelProcessState {
            status: TunnelStatus::default(),
            child: None,
            generation: 0,
        })
    })
}

/// 容忍毒化获取状态锁
fn lock_state() -> std::sync::MutexGuard<'static, TunnelProcessState> {
    state().lock().unwrap_or_else(|e| e.into_inner())
}

pub fn get_tunnel_status() -> TunnelStatus {
    let st = lock_state();
    st.status.clone()
}

/// 获取或创建 ~/.ReinAgent/bin 目录
fn ensure_bin_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    let bin_dir = home.join(".ReinAgent").join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("创建 bin 目录失败: {e}"))?;
    Ok(bin_dir)
}

/// 检查二进制是否具备基本有效性（文件存在、体积 >= 20MB 且 magic 字节匹配）
fn is_valid_cloudflared_binary(path: &Path) -> bool {
    if let Ok(metadata) = std::fs::metadata(path) {
        if metadata.is_file() && metadata.len() >= 20 * 1024 * 1024 {
            if let Ok(mut file) = std::fs::File::open(path) {
                let mut magic = [0u8; 4];
                if file.read_exact(&mut magic).is_ok() {
                    #[cfg(unix)]
                    if &magic != b"\x7fELF" {
                        return false;
                    }
                    #[cfg(windows)]
                    if &magic[..2] != b"MZ" {
                        return false;
                    }
                    return true;
                }
            }
        }
    }
    false
}

/// 查找已有的 cloudflared 二进制路径（PATH 或 ~/.ReinAgent/bin/）
fn find_existing_cloudflared() -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "cloudflared.exe"
    } else {
        "cloudflared"
    };

    // 1. 检查 ~/.ReinAgent/bin/
    if let Ok(bin_dir) = ensure_bin_dir() {
        let p = bin_dir.join(exe_name);
        if is_valid_cloudflared_binary(&p) {
            return Some(p);
        }
    }

    // 2. 检查系统 PATH
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(exe_name);
            if p.is_file() {
                return Some(p);
            }
        }
    }

    None
}

/// 依据当前平台定位下载 URL
fn cloudflared_download_url() -> Result<(&'static str, &'static str), String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    match (os, arch) {
        ("linux", "x86_64") => Ok((
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
            "cloudflared",
        )),
        ("linux", "aarch64") => Ok((
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64",
            "cloudflared",
        )),
        ("windows", "x86_64") => Ok((
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
            "cloudflared.exe",
        )),
        ("macos", "x86_64") | ("macos", "aarch64") => {
            Err("macOS 请在终端执行 brew install cloudflared 安装隧道支持".to_string())
        }
        _ => Err(format!("当前架构 ({os} {arch}) 暂不支持自动下载 cloudflared，请手动安装后放置在 PATH 中")),
    }
}

/// 下载并就位 cloudflared 二进制（流式写入、体积校验、可执行校验）
async fn download_cloudflared(app: &AppHandle) -> Result<PathBuf, String> {
    let (url, filename) = cloudflared_download_url()?;
    let bin_dir = ensure_bin_dir()?;
    let target_path = bin_dir.join(filename);
    let pid = std::process::id();
    let temp_path = bin_dir.join(format!("{filename}.part.{pid}.{}", uuid::Uuid::new_v4().simple()));

    update_progress(app, "正在下载 Cloudflare 隧道组件 (请稍候)...");

    let client = crate::app_proxy::build_proxied_reqwest_client(
        url,
        Some(std::time::Duration::from_secs(20)),
        Some(std::time::Duration::from_secs(300)),
    )?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("连接 GitHub 下载源失败: {e}。请检查网络或代理设置，您也可以手动在终端安装 cloudflared"))?;

    if !response.status().is_success() {
        return Err(format!("下载失败，HTTP 状态码: {}", response.status()));
    }

    let expected_len = response.content_length();
    let mut file = std::fs::File::create(&temp_path).map_err(|e| format!("创建临时文件失败: {e}"))?;
    let mut stream = response.bytes_stream();
    let mut downloaded_bytes: usize = 0;
    const MAX_BYTES: usize = 200 * 1024 * 1024; // 200MB 上限防御异常推送

    while let Some(chunk_res) = stream.next().await {
        let chunk = match chunk_res {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&temp_path);
                return Err(format!("读取下载数据中断: {e}"));
            }
        };
        downloaded_bytes += chunk.len();
        if downloaded_bytes > MAX_BYTES {
            let _ = std::fs::remove_file(&temp_path);
            return Err("下载文件超过体积上限 (200MB)，已终止".to_string());
        }
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("写入临时文件失败: {e}"));
        }
    }

    if let Err(e) = file.flush() {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("刷新临时文件失败: {e}"));
    }
    drop(file);

    // 比对 Content-Length 防止截断
    if let Some(expected) = expected_len {
        if (downloaded_bytes as u64) != expected {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("下载数据不完整: 实际接收 {downloaded_bytes} 字节，预期 {expected} 字节"));
        }
    }

    // cloudflared 官方二进制体积一般在 30MB ~ 70MB 之间；低于 20MB 判为不完整或受阻
    if downloaded_bytes < 20 * 1024 * 1024 {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("下载文件大小异常 (仅 {downloaded_bytes} 字节，小于 20MB)，可能遭遇网络阻断或劫持"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o755));
    }

    // 格式与 magic 校验
    if !is_valid_cloudflared_binary(&temp_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err("下载的文件格式或二进制头校验未通过".to_string());
    }

    // 执行 --version 验证可执行性及组件标识
    match Command::new(&temp_path).arg("--version").output() {
        Ok(output) if output.status.success() => {
            let out_str = String::from_utf8_lossy(&output.stdout);
            if !out_str.to_lowercase().contains("cloudflared") {
                let _ = std::fs::remove_file(&temp_path);
                return Err("下载的二进制未能识别为 cloudflared 组件".to_string());
            }
        }
        Ok(output) => {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("二进制版本校验退出码异常: {:?}", output.status.code()));
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("无法执行下载的二进制以校验版本: {e}"));
        }
    }

    let rename_res = std::fs::rename(&temp_path, &target_path);
    if let Err(e) = rename_res {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("重命名就位文件失败: {e}"));
    }

    Ok(target_path)
}

fn update_progress(app: &AppHandle, msg: &str) {
    let status_to_emit = {
        let mut st = lock_state();
        st.status.status = "starting".to_string();
        st.status.progress = Some(msg.to_string());
        st.status.clone()
    };
    let _ = app.emit("remote-server:tunnel-status", status_to_emit);
}

fn set_error(app: &AppHandle, err_msg: &str) {
    let status_to_emit = {
        let mut st = lock_state();
        st.status.status = "error".to_string();
        st.status.error = Some(err_msg.to_string());
        st.status.public_url = None;
        st.status.progress = None;
        st.status.clone()
    };
    let _ = app.emit("remote-server:tunnel-status", status_to_emit);
}

/// 停止当前正在运行的隧道（同步核心实现）
pub fn stop_tunnel_sync(app: Option<&AppHandle>) {
    let (child_to_kill, status_to_emit) = {
        let mut st = lock_state();
        st.generation = st.generation.wrapping_add(1);
        st.status.status = "stopped".to_string();
        st.status.public_url = None;
        st.status.error = None;
        st.status.progress = None;
        (st.child.take(), st.status.clone())
    };

    if let Some(mut child) = child_to_kill {
        let _ = child.kill();
        // 回收进程，避免僵尸进程
        let _ = child.wait();
    }

    if let Some(app) = app {
        let _ = app.emit("remote-server:tunnel-status", status_to_emit);
    }
}

/// 停止当前正在运行的隧道
pub async fn stop_tunnel(app: Option<&AppHandle>) {
    stop_tunnel_sync(app);
}

pub const TUNNEL_URL_REGEX: &str = r"https://[a-zA-Z0-9-]+\.trycloudflare\.com";

/// 启动 Cloudflare Quick Tunnel 监听指定本地端口
pub async fn start_cloudflare_tunnel(app: AppHandle, port: u32) -> Result<(), String> {
    stop_tunnel(Some(&app)).await;

    let res = start_cloudflare_tunnel_inner(&app, port).await;
    if let Err(ref e) = res {
        set_error(&app, e);
    }
    res
}

async fn start_cloudflare_tunnel_inner(app: &AppHandle, port: u32) -> Result<(), String> {
    let bin_path = match find_existing_cloudflared() {
        Some(p) => p,
        None => download_cloudflared(app).await?,
    };

    update_progress(app, "正在建立 Cloudflare 边缘安全连接...");

    let mut cmd = Command::new(&bin_path);
    cmd.args([
        "tunnel",
        "--url",
        &format!("http://127.0.0.1:{port}"),
        "--no-autoupdate",
    ]);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 cloudflared 失败: {e}"))?;
    let stderr = child.stderr.take().ok_or_else(|| "无法捕获隧道输出日志".to_string())?;

    let (my_gen, status_to_emit) = {
        let mut st = lock_state();
        st.generation = st.generation.wrapping_add(1);
        let gen = st.generation;
        st.status.mode = TunnelNetworkMode::Cloudflare;
        st.status.status = "starting".to_string();
        st.status.error = None;
        st.child = Some(child);
        (gen, st.status.clone())
    };
    let _ = app.emit("remote-server:tunnel-status", status_to_emit);

    // Watchdog: 45秒超时守护，防止边缘握手卡死导致永久停留于 starting
    let app_watchdog = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(45)).await;
        let status_to_emit = {
            let mut st = lock_state();
            if st.generation == my_gen && st.status.status == "starting" {
                st.status.status = "error".to_string();
                st.status.error = Some("建立 Cloudflare 隧道超时 (45秒未就绪)，请检查网络连接或代理设置".to_string());
                st.status.progress = None;
                Some(st.status.clone())
            } else {
                None
            }
        };
        if let Some(status) = status_to_emit {
            let _ = app_watchdog.emit("remote-server:tunnel-status", status);
        }
    });

    let app_clone = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let re = Regex::new(TUNNEL_URL_REGEX).expect("valid regex");

        let mut discovered = false;
        for line_res in reader.lines() {
            // 每次循环前先检查是否已被新一代隧道接管
            {
                let st = lock_state();
                if st.generation != my_gen {
                    return;
                }
            }

            match line_res {
                Ok(line) => {
                    if !discovered {
                        if let Some(matched) = re.find(&line) {
                            let url = matched.as_str().to_string();
                            discovered = true;
                            let status_to_emit = {
                                let mut st = lock_state();
                                if st.generation != my_gen {
                                    return;
                                }
                                st.status.status = "running".to_string();
                                st.status.public_url = Some(url);
                                st.status.progress = None;
                                st.status.error = None;
                                st.status.clone()
                            };
                            // 广播通知前端更新二维码与公网状态（锁外 emit）
                            let _ = app_clone.emit("remote-server:status", serde_json::json!({
                                "tunnelUpdated": true,
                            }));
                            let _ = app_clone.emit("remote-server:tunnel-status", status_to_emit);
                        }
                    }
                }
                Err(err) => {
                    // 管道非正常读取中断
                    eprintln!("cloudflared stderr read error: {err}");
                    break;
                }
            }
        }

        // 如果日志读取完毕退出
        let status_to_emit = {
            let mut st = lock_state();
            // 世代守卫：若当前世代已被更改（如用户点击重连或停止后有了新隧道），绝不覆盖状态！
            if st.generation != my_gen {
                return;
            }
            if st.status.status == "running" || st.status.status == "starting" {
                st.status.status = "error".to_string();
                st.status.error = Some("Cloudflare 隧道已断开或退出".to_string());
                st.status.public_url = None;
                Some(st.status.clone())
            } else {
                None
            }
        };

        if let Some(status) = status_to_emit {
            let _ = app_clone.emit("remote-server:tunnel-status", status);
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_network_mode_conversions() {
        assert_eq!(TunnelNetworkMode::from_str_opt("lan"), TunnelNetworkMode::Lan);
        assert_eq!(TunnelNetworkMode::from_str_opt("LAN"), TunnelNetworkMode::Lan);
        assert_eq!(TunnelNetworkMode::from_str_opt("cloudflare"), TunnelNetworkMode::Cloudflare);
        assert_eq!(TunnelNetworkMode::from_str_opt("CLOUDFLARE"), TunnelNetworkMode::Cloudflare);
        assert_eq!(TunnelNetworkMode::from_str_opt("custom"), TunnelNetworkMode::Custom);
        assert_eq!(TunnelNetworkMode::from_str_opt("invalid"), TunnelNetworkMode::Lan);

        assert_eq!(TunnelNetworkMode::Lan.as_str(), "lan");
        assert_eq!(TunnelNetworkMode::Cloudflare.as_str(), "cloudflare");
        assert_eq!(TunnelNetworkMode::Custom.as_str(), "custom");
    }

    #[test]
    fn test_cloudflared_url_regex() {
        let re = Regex::new(TUNNEL_URL_REGEX).unwrap();
        let sample_output = "2026-10-09T07:29:43Z INF +--------------------------------------------------------------------------------------------+
2026-10-09T07:29:43Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-10-09T07:29:43Z INF |  https://rein-agent-sample-tunnel.trycloudflare.com                                        |
2026-10-09T07:29:43Z INF +--------------------------------------------------------------------------------------------+";
        let matched = re.find(sample_output).expect("should find trycloudflare URL");
        assert_eq!(matched.as_str(), "https://rein-agent-sample-tunnel.trycloudflare.com");
    }

    #[test]
    fn test_is_valid_cloudflared_binary() {
        let temp_dir = tempfile::tempdir().unwrap();
        
        // 1. 小文件测试 (< 20MB)
        let small_file = temp_dir.path().join("small_bin");
        std::fs::write(&small_file, b"too small content").unwrap();
        assert!(!is_valid_cloudflared_binary(&small_file));

        // 2. 伪造大文件但 magic 不匹配
        let fake_big_file = temp_dir.path().join("fake_big_bin");
        let f = std::fs::File::create(&fake_big_file).unwrap();
        f.set_len(21 * 1024 * 1024).unwrap();
        assert!(!is_valid_cloudflared_binary(&fake_big_file));

        // 3. 具备有效 magic 字节的大文件
        let valid_big_file = temp_dir.path().join("valid_big_bin");
        let mut f2 = std::fs::File::create(&valid_big_file).unwrap();
        #[cfg(unix)]
        f2.write_all(b"\x7fELF").unwrap();
        #[cfg(windows)]
        f2.write_all(b"MZ\0\0").unwrap();
        f2.set_len(21 * 1024 * 1024).unwrap();
        assert!(is_valid_cloudflared_binary(&valid_big_file));
    }

    #[test]
    fn test_generation_guard() {
        let gen1 = {
            let mut st = lock_state();
            st.generation = st.generation.wrapping_add(1);
            st.status.status = "starting".to_string();
            st.generation
        };

        // 模拟外部触发了 stop 或新 start，generation 递增
        {
            let mut st = lock_state();
            st.generation = st.generation.wrapping_add(1);
            st.status.status = "running".to_string();
            st.status.public_url = Some("https://new-tunnel.trycloudflare.com".to_string());
        }

        // 旧线程根据 gen1 判断是否应该写状态
        {
            let mut st = lock_state();
            if st.generation == gen1 {
                st.status.status = "error".to_string();
            }
        }

        // 验证状态未被旧线程污染
        let st = lock_state();
        assert_eq!(st.status.status, "running");
        assert_eq!(st.status.public_url.as_deref(), Some("https://new-tunnel.trycloudflare.com"));
    }
}

