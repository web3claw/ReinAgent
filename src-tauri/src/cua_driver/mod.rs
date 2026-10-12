//! `cua-driver` 的探测 / 安装 / 权限查询与自卫事实提供。
//!
//! 计算机操作能力本身走通用 MCP 链路（`cua-driver mcp` 是一个标准 stdio MCP server，
//! 工具由 tools/list 发现）。此模块负责安装引导、TCC 权限检测以及宿主自卫所需的 PID 与屏幕矩形。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use wait_timeout::ChildExt;

/// 单次外部命令等待上限（探测、权限状态）
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// 安装脚本等待上限（下载解压）
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// 安装脚本进度事件名
pub const INSTALL_PROGRESS_EVENT: &str = "cua_driver_install_progress";

/// 官方安装脚本来源
const INSTALL_SCRIPT_URL_UNIX: &str = "https://cua.ai/driver/install.sh";
const INSTALL_SCRIPT_URL_WINDOWS: &str = "https://cua.ai/driver/install.ps1";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaDriverProbe {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub mcp_command: Option<String>,
    pub mcp_args: Vec<String>,
    pub permissions_required: bool,
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaDriverPermissions {
    pub supported: bool,
    pub accessibility: bool,
    pub screen_recording: bool,
    pub attributed_to: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCommandPreview {
    pub program: String,
    pub args: Vec<String>,
    pub display: String,
    pub source_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub stream: String,
    pub line: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfIdentity {
    pub pid: u32,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfWindowRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

const fn platform_requires_permissions() -> bool {
    cfg!(target_os = "macos")
}

fn find_binary() -> Option<PathBuf> {
    if let Some(found) = find_in_path("cua-driver") {
        return Some(found);
    }
    candidate_paths().into_iter().find(|p| p.is_file())
}

fn find_in_path(binary: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(target_os = "windows")]
        {
            let with_exe = dir.join(format!("{binary}.exe"));
            if with_exe.is_file() {
                return Some(with_exe);
            }
        }
    }
    None
}

fn candidate_paths() -> Vec<PathBuf> {
    let home = dirs::home_dir();
    let mut out: Vec<PathBuf> = Vec::new();

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = home.as_ref() {
            out.push(home.join(".local/bin/cua-driver"));
            out.push(home.join(".cua/bin/cua-driver"));
        }
        out.push(PathBuf::from("/usr/local/bin/cua-driver"));
        out.push(PathBuf::from("/opt/homebrew/bin/cua-driver"));
    }

    #[cfg(target_os = "macos")]
    {
        out.push(PathBuf::from(
            "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
        ));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(home) = home.as_ref() {
            out.push(home.join(".local\\bin\\cua-driver.exe"));
            out.push(home.join("AppData\\Local\\Programs\\cua-driver\\cua-driver.exe"));
        }
    }

    let _ = &home;
    out
}

fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(program)
    }
}

fn run_capture(program: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = hidden_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to spawn {}: {error}", program.display()))?;

    let status = match child
        .wait_timeout(PROBE_TIMEOUT)
        .map_err(|error| format!("wait failed: {error}"))?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "{} {} timed out after {}s",
                program.display(),
                args.join(" "),
                PROBE_TIMEOUT.as_secs()
            ));
        }
    };

    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to collect output: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "exit {}: {}",
            status.code().unwrap_or(-1),
            if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            }
        ));
    }
    Ok(stdout)
}

pub fn probe() -> CuaDriverProbe {
    let Some(path) = find_binary() else {
        return CuaDriverProbe {
            permissions_required: platform_requires_permissions(),
            ..Default::default()
        };
    };

    let mut probe = CuaDriverProbe {
        installed: true,
        path: Some(path.to_string_lossy().into_owned()),
        permissions_required: platform_requires_permissions(),
        ..Default::default()
    };

    match run_capture(&path, &["manifest"]) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(manifest) => {
                probe.version = manifest
                    .get("binary_version")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let invocation = manifest.get("mcp_invocation");
                probe.mcp_command = invocation
                    .and_then(|v| v.get("command"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                probe.mcp_args = invocation
                    .and_then(|v| v.get("args"))
                    .and_then(Value::as_array)
                    .map(|args| {
                        args.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
            }
            Err(error) => probe.error = Some(format!("failed to parse manifest: {error}")),
        },
        Err(error) => probe.error = Some(error),
    }

    if probe.mcp_command.is_none() {
        probe.mcp_command = probe.path.clone();
        probe.mcp_args = vec!["mcp".to_string()];
    }

    probe
}

pub fn self_identity() -> SelfIdentity {
    SelfIdentity {
        pid: std::process::id(),
    }
}

pub fn frontmost_pid() -> Result<u32, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId,
        };
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return Err("no foreground window".to_string());
        }
        let mut pid: u32 = 0;
        let thread = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if thread == 0 || pid == 0 {
            return Err("failed to resolve foreground window process".to_string());
        }
        Ok(pid)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("frontmost application detection is not supported on this platform".to_string())
    }
}

pub fn self_window_rects(app: &AppHandle) -> Vec<SelfWindowRect> {
    use tauri::Manager;

    app.webview_windows()
        .values()
        .filter_map(|window| {
            if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
                return None;
            }
            let scale = window.scale_factor().unwrap_or(1.0);
            let position = window.outer_position().ok()?.to_logical::<f64>(scale);
            let size = window.outer_size().ok()?.to_logical::<f64>(scale);
            Some(SelfWindowRect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            })
        })
        .collect()
}

pub fn permissions_status() -> CuaDriverPermissions {
    if !cfg!(target_os = "macos") {
        return CuaDriverPermissions::default();
    }
    let Some(path) = find_binary() else {
        return CuaDriverPermissions {
            supported: true,
            error: Some("cua-driver not installed".into()),
            ..Default::default()
        };
    };

    match run_capture(&path, &["permissions", "status", "--json"]) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(payload) => CuaDriverPermissions {
                supported: true,
                accessibility: payload
                    .get("accessibility")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                screen_recording: payload
                    .get("screen_recording")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                attributed_to: payload
                    .get("source")
                    .and_then(|source| source.get("bundle_id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                error: None,
            },
            Err(error) => CuaDriverPermissions {
                supported: true,
                error: Some(format!("failed to parse permissions payload: {error}")),
                ..Default::default()
            },
        },
        Err(error) => CuaDriverPermissions {
            supported: true,
            error: Some(error),
            ..Default::default()
        },
    }
}

pub fn permissions_grant() -> Result<CuaDriverPermissions, String> {
    if !cfg!(target_os = "macos") {
        return Ok(CuaDriverPermissions::default());
    }
    let path = find_binary().ok_or_else(|| "cua-driver not installed".to_string())?;
    run_capture(&path, &["permissions", "grant"])?;
    Ok(permissions_status())
}

fn unix_install_script(script_url: &str) -> String {
    format!("set -o pipefail; curl -fsSL {script_url} | /bin/bash")
}

pub fn install_command_preview() -> InstallCommandPreview {
    if cfg!(target_os = "windows") {
        let inner = format!("irm {INSTALL_SCRIPT_URL_WINDOWS} | iex");
        InstallCommandPreview {
            program: "powershell".into(),
            args: vec!["-NoProfile".into(), "-Command".into(), inner.clone()],
            display: format!("powershell -NoProfile -Command \"{inner}\""),
            source_url: INSTALL_SCRIPT_URL_WINDOWS.into(),
        }
    } else {
        let inner = unix_install_script(INSTALL_SCRIPT_URL_UNIX);
        InstallCommandPreview {
            program: "/bin/bash".into(),
            args: vec!["-c".into(), inner.clone()],
            display: format!("/bin/bash -c \"{inner}\""),
            source_url: INSTALL_SCRIPT_URL_UNIX.into(),
        }
    }
}

pub fn install(app: &AppHandle) -> Result<CuaDriverProbe, String> {
    let preview = install_command_preview();
    let mut child = hidden_command(&preview.program)
        .args(&preview.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to launch installer: {error}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pump = |handle: Option<Box<dyn std::io::Read + Send>>, stream: &'static str| {
        let app = app.clone();
        handle.map(|reader| {
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in std::io::BufReader::new(reader).lines().map_while(Result::ok) {
                    let _ = app.emit(
                        INSTALL_PROGRESS_EVENT,
                        InstallProgress {
                            stream: stream.to_string(),
                            line,
                        },
                    );
                }
            })
        })
    };
    let out_pump = pump(
        stdout.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        "stdout",
    );
    let err_pump = pump(
        stderr.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        "stderr",
    );

    let status = match child
        .wait_timeout(INSTALL_TIMEOUT)
        .map_err(|error| format!("installer wait failed: {error}"))?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let message = format!(
                "installer timed out after {} minutes",
                INSTALL_TIMEOUT.as_secs() / 60
            );
            let _ = app.emit(
                INSTALL_PROGRESS_EVENT,
                InstallProgress {
                    stream: "failed".into(),
                    line: message.clone(),
                },
            );
            return Err(message);
        }
    };
    if let Some(handle) = out_pump {
        let _ = handle.join();
    }
    if let Some(handle) = err_pump {
        let _ = handle.join();
    }

    if !status.success() {
        let message = format!("installer exited with {}", status.code().unwrap_or(-1));
        let _ = app.emit(
            INSTALL_PROGRESS_EVENT,
            InstallProgress {
                stream: "failed".into(),
                line: message.clone(),
            },
        );
        return Err(message);
    }

    let probe = probe();
    let _ = app.emit(
        INSTALL_PROGRESS_EVENT,
        InstallProgress {
            stream: "done".into(),
            line: probe
                .version
                .clone()
                .map(|version| format!("cua-driver {version}"))
                .unwrap_or_else(|| "installed".into()),
        },
    );
    Ok(probe)
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_probe() -> Result<CuaDriverProbe, String> {
    tauri::async_runtime::spawn_blocking(probe)
        .await
        .map_err(|error| format!("cua_driver_probe join failed: {error}"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_driver_install_command() -> InstallCommandPreview {
    install_command_preview()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_install(app: AppHandle) -> Result<CuaDriverProbe, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app))
        .await
        .map_err(|error| format!("cua_driver_install join failed: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_permissions_status() -> Result<CuaDriverPermissions, String> {
    tauri::async_runtime::spawn_blocking(permissions_status)
        .await
        .map_err(|error| format!("cua_driver_permissions_status join failed: {error}"))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_permissions_grant() -> Result<CuaDriverPermissions, String> {
    tauri::async_runtime::spawn_blocking(permissions_grant)
        .await
        .map_err(|error| format!("cua_driver_permissions_grant join failed: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_driver_self_identity() -> SelfIdentity {
    self_identity()
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_driver_self_windows(app: AppHandle) -> Vec<SelfWindowRect> {
    self_window_rects(&app)
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_driver_frontmost_pid() -> Result<u32, String> {
    frontmost_pid()
}
