//! 系统信息（P2-G2 尾巴：终端 Shell 标签的 OS 检测）。
//!
//! 返回 OS 家族/发行版版本/架构，前端拼「Shell (Win 11 amd64)」式标签。
//! Windows 版本号经 `cmd /c ver` 解析 build 号（≥22000 = Win 11）；
//! Linux 读 /etc/os-release 的 PRETTY_NAME（如 "Ubuntu 24.04.1 LTS"）。

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// windows | linux | macos
    pub os: String,
    /// 展示用版本（Win 11 / Win 10 / Ubuntu 24.04.1 LTS / macOS 14.5 …）
    pub version: String,
    /// amd64 | arm64（x86_64/aarch64 的展示别名）
    pub arch: String,
    /// 登录默认 shell（$SHELL；windows 为空）
    pub default_shell: String,
}

#[tauri::command]
pub fn system_info() -> SystemInfo {
    let os = std::env::consts::OS.to_string();
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64".to_string(),
        "aarch64" => "arm64".to_string(),
        other => other.to_string(),
    };
    let version = match os.as_str() {
        "windows" => windows_version(),
        "linux" => linux_version(),
        "macos" => macos_version(),
        _ => String::new(),
    };
    let default_shell = if os == "linux" || os == "macos" {
        std::env::var("SHELL").unwrap_or_default()
    } else {
        String::new()
    };
    SystemInfo { os, version, arch, default_shell }
}

/// Windows：`cmd /c ver` 输出形如 "Microsoft Windows [Version 10.0.26100.9444]"，
/// 取第三段（build 号）判 Win 10/11（≥22000 = Win 11）。
fn windows_version() -> String {
    let output = std::process::Command::new("cmd")
        .args(["/C", "ver"])
        .output();
    let text = match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_string(),
        Err(_) => return "Windows".to_string(),
    };
    let build = text
        .split("Version")
        .nth(1)
        .and_then(|v| {
            v.trim()
                .trim_end_matches(']')
                .trim()
                .split('.')
                .nth(2)
                .and_then(|b| b.trim().parse::<u32>().ok())
        });
    match build {
        Some(b) if b >= 22000 => "Win 11".to_string(),
        Some(_) => "Win 10".to_string(),
        None => "Windows".to_string(),
    }
}

/// Linux：/etc/os-release 的 PRETTY_NAME（如 "Ubuntu 24.04.1 LTS"）；读不到回退 "Linux"。
fn linux_version() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|content| {
            content.lines().find_map(|line| {
                line.strip_prefix("PRETTY_NAME=").map(|v| {
                    v.trim().trim_matches('"').trim_matches('\'').to_string()
                })
            })
        })
        .unwrap_or_else(|| "Linux".to_string())
}

/// macOS：sw_vers -productVersion；失败回退 "macOS"。
fn macos_version() -> String {
    let output = std::process::Command::new("sw_vers").args(["-productVersion"]).output();
    match output {
        Ok(out) => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if v.is_empty() { "macOS".to_string() } else { format!("macOS {v}") }
        }
        Err(_) => "macOS".to_string(),
    }
}
