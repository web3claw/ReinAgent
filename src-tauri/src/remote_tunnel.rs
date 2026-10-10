//! 远程访问公网隧道管理模块（Cloudflare Quick Tunnel / 自定义公网地址）。
//!
//! 功能职责：
//! 1. 网络模式管理：局域网 (Lan) / Cloudflare 免费免配置公网隧道 (Cloudflare) / 用户自定义反代域名 (Custom)；
//! 2. `cloudflared` 二进制管理：优先检测系统环境，缺失时安全下载至 `~/.ReinAgent/bin/`；
//! 3. 隧道子进程生命周期：异步启动、日志监听、正则捕获公网 HTTPS 域名、异常重试与优雅退出。

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
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
}

static TUNNEL_STATE: OnceLock<Arc<Mutex<TunnelProcessState>>> = OnceLock::new();

fn state() -> Arc<Mutex<TunnelProcessState>> {
    TUNNEL_STATE
        .get_or_init(|| {
            Arc::new(Mutex::new(TunnelProcessState {
                status: TunnelStatus::default(),
                child: None,
            }))
        })
        .clone()
}

pub fn get_tunnel_status() -> TunnelStatus {
    let binding = state();
    let st = binding.lock().expect("tunnel state lock");
    st.status.clone()
}

/// 获取或创建 ~/.ReinAgent/bin 目录
fn ensure_bin_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    let bin_dir = home.join(".ReinAgent").join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("创建 bin 目录失败: {e}"))?;
    Ok(bin_dir)
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
        if p.is_file() {
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

/// 下载并就位 cloudflared 二进制
async fn download_cloudflared(app: &AppHandle) -> Result<PathBuf, String> {
    let (url, filename) = cloudflared_download_url()?;
    let bin_dir = ensure_bin_dir()?;
    let target_path = bin_dir.join(filename);
    let temp_path = bin_dir.join(format!("{filename}.part"));

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

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取下载数据中断: {e}"))?;

    if bytes.len() < 1024 * 1024 {
        return Err(format!("下载文件大小异常 (仅 {} 字节)，可能遭遇网络劫持", bytes.len()));
    }

    std::fs::write(&temp_path, &bytes).map_err(|e| format!("保存临时文件失败: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o755));
    }

    std::fs::rename(&temp_path, &target_path).map_err(|e| format!("重命名就位文件失败: {e}"))?;

    Ok(target_path)
}

fn update_progress(app: &AppHandle, msg: &str) {
    let binding = state();
    let mut st = binding.lock().expect("tunnel state lock");
    st.status.status = "starting".to_string();
    st.status.progress = Some(msg.to_string());
    drop(st);
    let _ = app.emit("remote-server:tunnel-status", get_tunnel_status());
}

/// 停止当前正在运行的隧道
pub async fn stop_tunnel(app: Option<&AppHandle>) {
    let child_to_kill = {
        let binding = state();
        let mut st = binding.lock().expect("tunnel state lock");
        st.status.status = "stopped".to_string();
        st.status.public_url = None;
        st.status.error = None;
        st.status.progress = None;
        st.child.take()
    };
    if let Some(mut child) = child_to_kill {
        let _ = child.kill();
    }
    if let Some(app) = app {
        let _ = app.emit("remote-server:tunnel-status", get_tunnel_status());
    }
}

/// 启动 Cloudflare Quick Tunnel 监听指定本地端口
pub async fn start_cloudflare_tunnel(app: AppHandle, port: u32) -> Result<(), String> {
    stop_tunnel(Some(&app)).await;

    let bin_path = match find_existing_cloudflared() {
        Some(p) => p,
        None => download_cloudflared(&app).await?,
    };

    update_progress(&app, "正在建立 Cloudflare 边缘安全连接...");

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

    {
        let binding = state();
        let mut st = binding.lock().expect("tunnel state lock");
        st.status.mode = TunnelNetworkMode::Cloudflare;
        st.status.status = "starting".to_string();
        st.child = Some(child);
    }
    let _ = app.emit("remote-server:tunnel-status", get_tunnel_status());

    let app_clone = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let re = Regex::new(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com").expect("valid regex");

        let mut discovered = false;
        for line_res in reader.lines() {
            if let Ok(line) = line_res {
                if !discovered {
                    if let Some(matched) = re.find(&line) {
                        let url = matched.as_str().to_string();
                        discovered = true;
                        {
                            let binding = state();
                            let mut st = binding.lock().expect("tunnel state lock");
                            st.status.status = "running".to_string();
                            st.status.public_url = Some(url);
                            st.status.progress = None;
                            st.status.error = None;
                        }
                        // 广播通知前端更新二维码与公网状态
                        let _ = app_clone.emit("remote-server:status", serde_json::json!({
                            "tunnelUpdated": true,
                        }));
                        let _ = app_clone.emit("remote-server:tunnel-status", get_tunnel_status());
                    }
                }
            }
        }

        // 如果日志读取完毕退出
        let binding = state();
        let mut st = binding.lock().expect("tunnel state lock");
        if st.status.status == "running" || st.status.status == "starting" {
            st.status.status = "error".to_string();
            st.status.error = Some("Cloudflare 隧道已断开或退出".to_string());
            st.status.public_url = None;
            let _ = app_clone.emit("remote-server:tunnel-status", st.status.clone());
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
        let re = Regex::new(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com").unwrap();
        let sample_output = "2026-10-09T07:29:43Z INF +--------------------------------------------------------------------------------------------+
2026-10-09T07:29:43Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-10-09T07:29:43Z INF |  https://rein-agent-sample-tunnel.trycloudflare.com                                        |
2026-10-09T07:29:43Z INF +--------------------------------------------------------------------------------------------+";
        let matched = re.find(sample_output).expect("should find trycloudflare URL");
        assert_eq!(matched.as_str(), "https://rein-agent-sample-tunnel.trycloudflare.com");
    }
}
