//! SSH 工作区支持（ROADMAP ⑫，Hetu WorkCommandRunner / WorkRemoteFs 移植）。
//!
//! 架构：系统 ssh 客户端 + shell 命令模拟文件 API（非 sshfs、不嵌 SSH 库）。
//! 工作区表示 `ssh://[user@]host[:port]/path`（path 支持 ~ 前缀）——任务/看板/
//! 自动化的 workspacePath 直接存该 scheme，Rust 命令入口嗅探后路由到远程分支。
//!
//! 认证：Key/Agent 走系统 ssh 默认生态（BatchMode）；密码走 SSH_ASKPASS
//! （SSH_ASKPASS_REQUIRE=force，临时脚本 0700 用后即删；仅 Linux——Windows
//! OpenSSH 无 askpass 机制，密码认证如实报错）。密码存 `~/.ReinAgent/ssh_auth.json`
//! （0600，键 `user@host:port`）；测试可用 env `REINAGENT_SSH_PASSWORD` 覆盖。
//!
//! 代理：env `REINAGENT_SSH_PROXY` 优先，否则沿用应用出网代理 kv
//! （`reinagent-web-proxy`，no_proxy 显式命中主机时直连）——
//! ProxyCommand = `nc -X connect -x {proxy} %h %p`（HTTP CONNECT）。

use crate::fs_cmd::FileTextSlice;
use crate::fs_search::{GlobEntry, GlobResult, GrepHit, GrepResult};
use regex::Regex;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

/// 网络命令默认超时（Hetu SshCommandTimeoutSeconds 同值）
pub const SSH_TIMEOUT_SECS: u64 = 60;
/// 认证文件
fn auth_file() -> PathBuf {
    crate::app_proxy::kv_db_path()
        .parent()
        .map(|p| p.join("ssh_auth.json"))
        .unwrap_or_else(|| PathBuf::from(".ReinAgent/ssh_auth.json"))
}

// ===== scheme 解析与路径规则 =====

#[derive(Debug, Clone, PartialEq)]
pub struct SshTarget {
    pub user: Option<String>,
    pub host: String,
    pub port: u16,
    /// 远端项目根目录（保留 ~ 前缀，远端 shell 展开）
    pub root: String,
}

pub fn is_ssh_workspace(value: &str) -> bool {
    value.trim().to_lowercase().starts_with("ssh://")
}

/// 解析 `ssh://[user@]host[:port]/path`；path 必填（根目录）
pub fn parse_ssh_workspace(value: &str) -> Result<SshTarget, String> {
    let trimmed = value.trim();
    let rest = trimmed
        .strip_prefix("ssh://")
        .ok_or_else(|| format!("非 ssh:// 工作区：{trimmed}"))?;
    let (authority, path) = rest
        .split_once('/')
        .ok_or_else(|| format!("ssh:// 工作区缺少远端路径：{trimmed}"))?;
    if path.trim().is_empty() {
        return Err(format!("ssh:// 工作区缺少远端路径：{trimmed}"));
    }
    let (user, hostport) = match authority.rsplit_once('@') {
        Some((u, hp)) => {
            let user = u.trim();
            if user.is_empty() {
                return Err(format!("ssh:// 用户名为空：{trimmed}"));
            }
            (Some(user.to_string()), hp)
        }
        None => (None, authority),
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => {
            let port: u16 = p
                .parse()
                .map_err(|_| format!("ssh:// 端口非法：{hostport}"))?;
            (h.to_string(), port)
        }
        None => (hostport.to_string(), 22),
    };
    if host.trim().is_empty() {
        return Err(format!("ssh:// 主机为空：{trimmed}"));
    }
    Ok(SshTarget {
        user,
        host: host.trim().to_string(),
        port,
        root: format!("/{path}"),
    })
}

/// target → workspace 字符串（反向）
pub fn target_to_workspace(target: &SshTarget) -> String {
    let hostport = if target.port == 22 {
        target.host.clone()
    } else {
        format!("{}:{}", target.host, target.port)
    };
    match &target.user {
        Some(u) => format!("ssh://{u}@{hostport}{}", target.root),
        None => format!("ssh://{hostport}{}", target.root),
    }
}

/// 相对路径逃逸守卫（Hetu Escapes 同构）：任何 `..` 段即拒绝
pub fn rel_escapes(rel: &str) -> bool {
    rel.replace('\\', "/")
        .split('/')
        .any(|seg| seg == "..")
}

/// root + 相对路径 → 远端绝对路径（root 的 ~ 前缀保留；逃逸拒绝）。
/// rel 为空 = root 本身。
pub fn join_remote(root: &str, rel: &str) -> Result<String, String> {
    let rel_clean = rel.replace('\\', "/").trim().trim_matches('/').to_string();
    if !rel_clean.is_empty() && rel_escapes(&rel_clean) {
        return Err(format!("路径超出项目范围: {rel_clean}"));
    }
    if rel_clean.is_empty() {
        return Ok(quote_ready_root(root));
    }
    // ~ 前缀统一转 $HOME 形态：单引号会阻止波浪号展开（Hetu 踩坑），$HOME 可双引号安全保留
    Ok(format!("{}/{}", quote_ready_root(root), rel_clean))
}

/// 远端绝对/伪绝对路径 → 相对 root 的显示路径（find/grep 输出归一用）。
/// `$HOME/...` 与 root 的 `~/...` 形态互认。
pub fn relative_to_root(root: &str, joined: &str) -> Option<String> {
    let joined = joined.trim();
    let home_prefix = "$HOME";
    let candidates: Vec<String> = if root == "~" || root == "~/" {
        vec![home_prefix.to_string()]
    } else {
        let r = root.trim_end_matches('/');
        vec![r.to_string(), format!("{home_prefix}{}", r.strip_prefix('~').unwrap_or(r))]
    };
    for cand in &candidates {
        if let Some(rest) = joined.strip_prefix(cand.as_str()) {
            let rest = rest.trim_start_matches('/');
            return Some(rest.to_string());
        }
    }
    None
}

/// root → 归一化（~ 前缀转 $HOME，无引号）；join_remote 内部用
fn quote_ready_root(root: &str) -> String {
    let value = root.trim();
    let value = if let Some(rest) = value.strip_prefix("\\~") {
        format!("~{rest}")
    } else {
        value.to_string()
    };
    if value == "~" || value == "~/" {
        return "$HOME".to_string();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return format!("$HOME/{}", rest.trim_end_matches('/'));
    }
    value.trim_end_matches('/').to_string()
}

/// 远端路径引用：$HOME 前缀用双引号（保留展开），其余单引号
pub fn quote_remote_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("$HOME") {
        if rest.is_empty() {
            return "\"$HOME\"".to_string();
        }
        let esc = rest
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('`', "\\`")
            .replace('$', "\\$");
        return format!("\"$HOME{esc}\"");
    }
    shell_quote(path)
}

/// POSIX 单引号安全包裹
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 远端根目录引用（Hetu QuoteRootPath 同构）：~ 必须保留展开
pub fn quote_root(root: &str) -> String {
    let value = root.trim();
    if value.is_empty() {
        return "\"$HOME\"".to_string();
    }
    let value = if let Some(rest) = value.strip_prefix("\\~") {
        format!("~{rest}")
    } else {
        value.to_string()
    };
    if value == "~" {
        return "\"$HOME\"".to_string();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if rest.is_empty() {
            return "\"$HOME\"".to_string();
        }
        return format!("\"$HOME/{}\"", rest.replace('"', "\\\""));
    }
    shell_quote(&value)
}

// ===== 认证 =====

#[derive(Serialize, Deserialize, Default)]
struct SshAuthFile {
    #[serde(flatten)]
    entries: std::collections::HashMap<String, String>,
}

fn auth_key(target: &SshTarget) -> String {
    format!("{}@{}:{}", target.user.as_deref().unwrap_or(""), target.host, target.port)
}

/// 密码读取：env `REINAGENT_SSH_PASSWORD`（测试覆盖，作用于任意主机）优先，
/// 其次 `~/.ReinAgent/ssh_auth.json`（0600）。
pub fn read_ssh_password(target: &SshTarget) -> Option<String> {
    if let Ok(pw) = std::env::var("REINAGENT_SSH_PASSWORD") {
        if !pw.trim().is_empty() {
            return Some(pw);
        }
    }
    let text = std::fs::read_to_string(auth_file()).ok()?;
    let parsed: SshAuthFile = serde_json::from_str(&text).ok()?;
    parsed.entries.get(&auth_key(target)).filter(|p| !p.is_empty()).cloned()
}

/// 保存密码（0600；UI 表单用）。Windows 下如实拒绝（无 askpass 机制）。
pub fn store_ssh_password(target: &SshTarget, password: &str) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        return Err("Windows 下暂不支持密码认证（OpenSSH 无 askpass 机制），请改用密钥".into());
    }
    use std::io::Write;
    let path = auth_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut entries: SshAuthFile = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if password.is_empty() {
        entries.entries.remove(&auth_key(target));
    } else {
        entries.entries.insert(auth_key(target), password.to_string());
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    file.write_all(serde_json::to_string(&entries).unwrap_or_default().as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ===== Runner =====

#[derive(Debug, Clone)]
pub struct SshOutcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl SshOutcome {
    pub fn combined(&self) -> String {
        if self.stderr.trim().is_empty() {
            self.stdout.clone()
        } else {
            format!("{}{}", self.stdout, self.stderr)
        }
    }
}

/// SSH 代理：env `REINAGENT_SSH_PROXY` > 应用出网代理 kv（no_proxy 显式命中主机则直连）。
/// 返回 host:port（无 scheme）。
pub fn proxy_for_ssh(host: &str) -> Option<String> {
    if let Ok(p) = std::env::var("REINAGENT_SSH_PROXY") {
        let p = p.trim().to_string();
        if !p.is_empty() {
            return Some(strip_scheme(&p));
        }
        return None; // 显式置空 = 强制直连
    }
    let (proxy, no_proxy) = crate::app_proxy::read_proxy_settings();
    let proxy = proxy.trim().to_string();
    if proxy.is_empty() {
        return None;
    }
    // no_proxy：逗号分隔；精确 host 匹配或域后缀匹配（IP 字面量只做精确匹配）
    let host_lc = host.to_lowercase();
    for rule in no_proxy.split(',') {
        let rule = rule.trim().to_lowercase();
        if rule.is_empty() || rule == "*" {
            continue; // 既往教训：* 不匹配 IP 字面量——SSH 侧同样不把 * 当通配
        }
        if let Some(ip) = rule.strip_prefix('.') {
            if host_lc.ends_with(ip) {
                return None;
            }
        } else if host_lc == rule || host_lc.ends_with(&format!(".{rule}")) {
            return None;
        }
    }
    Some(strip_scheme(&proxy))
}

fn strip_scheme(proxy: &str) -> String {
    let p = proxy.trim();
    p.split("://").nth(1).unwrap_or(p).trim_end_matches('/').to_string()
}

/// 构造 ssh 参数（不含远端命令与目标地址）
pub fn build_ssh_args(target: &SshTarget, key_path: Option<&str>, use_password: bool, proxy: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    args.push("-p".into());
    args.push(target.port.to_string());
    if !use_password {
        // 密码认证下 BatchMode 会禁用 askpass 取词——只在 Key/Agent 模式开启
        args.push("-o".into());
        args.push("BatchMode=yes".into());
    }
    args.extend(["-o".into(), "StrictHostKeyChecking=accept-new".into()]);
    args.extend(["-o".into(), "ConnectTimeout=10".into()]);
    // keepalive：链路半死 15s 内自判断连（Hetu 实测坑）
    args.extend(["-o".into(), "ServerAliveInterval=5".into()]);
    args.extend(["-o".into(), "ServerAliveCountMax=3".into()]);
    args.extend(["-o".into(), "TCPKeepAlive=yes".into()]);
    args.extend(["-o".into(), "NumberOfPasswordPrompts=1".into()]);
    if let Some(p) = proxy {
        args.extend([
            "-o".into(),
            format!("ProxyCommand=nc -X connect -x {} %h %p", shell_quote(p)),
        ]);
    }
    if let Some(k) = key_path.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("-i".into());
        args.push(k.to_string());
    }
    match &target.user {
        Some(u) => args.push(format!("{u}@{}", target.host)),
        None => args.push(target.host.clone()),
    }
    args
}

/// 执行远端命令（cd root && command）。stdin 走管道（写文件用）。
pub async fn ssh_run(
    target: &SshTarget,
    command: &str,
    stdin: Option<&str>,
    timeout_secs: u64,
    key_path: Option<&str>,
) -> Result<SshOutcome, String> {
    let password = read_ssh_password(target);
    let proxy = proxy_for_ssh(&target.host);
    let mut cmd = Command::new("ssh");
    cmd.args(build_ssh_args(target, key_path, password.is_some(), proxy.as_deref()));
    let remote = format!("cd {} && {}", quote_root(&target.root), command);
    cmd.arg(&remote);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if stdin.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    } else {
        cmd.stdin(std::process::Stdio::null());
    }
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    // 密码认证：SSH_ASKPASS 临时脚本（0700，用后即删；仅 Linux/macOS）
    let mut askpass_path: Option<PathBuf> = None;
    if password.is_some() {
        if cfg!(target_os = "windows") {
            return Err("Windows 下暂不支持 SSH 密码认证，请改用密钥".into());
        }
        let path = std::env::temp_dir().join(format!(
            "reinagent-askpass-{}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos() as u64 + d.as_secs())
                .unwrap_or(0)
        ));
        std::fs::write(&path, format!("#!/bin/sh\nprintf '%s\\n' {}\n", shell_quote(password.as_deref().unwrap_or(""))))
            .map_err(|e| format!("写 askpass 失败：{e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        }
        cmd.env("SSH_ASKPASS", &path);
        cmd.env("SSH_ASKPASS_REQUIRE", "force");
        cmd.env("DISPLAY", std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into()));
        askpass_path = Some(path);
    }

    let result = async {
        let mut child = cmd.spawn().map_err(|e| format!("ssh 启动失败（未安装或不在 PATH）：{e}"))?;
        if let Some(body) = stdin {
            use tokio::io::AsyncWriteExt;
            if let Some(mut sin) = child.stdin.take() {
                let _ = sin.write_all(body.as_bytes()).await;
            }
        }
        match tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                Ok(SshOutcome { code: output.status.code().unwrap_or(-1), stdout, stderr })
            }
            Ok(Err(e)) => Err(format!("ssh 执行失败：{e}")),
            Err(_) => Err(format!(
                "ssh 命令超过 {timeout_secs} 秒无响应（连接可能已断开），请检查网络后重试"
            )),
        }
    }
    .await;
    if let Some(p) = askpass_path {
        let _ = std::fs::remove_file(p);
    }
    result
}

// ===== 远端文件操作（WorkRemoteFs 移植）=====

/// ls -laA 解析 → 名称数组（镜像 fs_list_dir 的 Vec<String> 返回形态；
/// 500 项截断，忽略条目与根目录同规则由调用方处理）
pub async fn ssh_list_dir_entries(target: &SshTarget, path: &str) -> Result<Vec<String>, String> {
    let quoted = quote_remote_path(path);
    let out = ssh_run(target, &format!("ls -1A {quoted}"), None, SSH_TIMEOUT_SECS, None).await?;
    if out.code != 0 {
        return Err(format!("列出目录失败: {}", first_line(&out.stderr).unwrap_or_else(|| "未知错误".to_string())));
    }
    Ok(out.stdout.lines().map(str::to_string).filter(|l| !l.trim().is_empty()).collect())
}

/// cat 读文件（含二进制探测与字节上限，镜像 FileTextSlice 契约）
pub async fn ssh_read_slice(target: &SshTarget, path: &str, offset: usize, length: usize) -> Result<FileTextSlice, String> {
    const MAX_READ_BYTES: usize = 512 * 1024;
    let quoted = quote_remote_path(path);
    let out = ssh_run(
        target,
        &format!("wc -c < {quoted} && cat {quoted}"),
        None,
        SSH_TIMEOUT_SECS,
        None,
    )
    .await?;
    if out.code != 0 {
        return Err(format!("读取文件失败: {}", first_line(&out.stderr).unwrap_or_else(|| "未知错误".to_string())));
    }
    let (total_line, content) = match out.stdout.split_once('\n') {
        Some((a, b)) => (a.trim().to_string(), b.to_string()),
        None => (out.stdout.trim().to_string(), String::new()),
    };
    let total_bytes: usize = total_line.parse().unwrap_or(content.len());
    // 二进制探测：含 NUL 即判二进制（镜像本地 read_text_file 语义的简化版）
    let is_binary = content.as_bytes().contains(&0);
    let raw = if is_binary { String::new() } else { content };
    let bytes = raw.as_bytes();
    let start = offset.min(bytes.len());
    let end = if length == 0 { bytes.len() } else { start.saturating_add(length).min(bytes.len()) };
    let slice = &bytes[start..end];
    Ok(FileTextSlice {
        path: path.to_string(),
        content: String::from_utf8_lossy(slice).to_string(),
        offset: start,
        bytes_read: slice.len(),
        total_bytes,
        truncated: end < bytes.len() || total_bytes > MAX_READ_BYTES,
        is_binary,
    })
}

/// 写文件：mkdir -p + cat >（正文走 stdin 防转义）
pub async fn ssh_write_file(target: &SshTarget, path: &str, content: &str) -> Result<(), String> {
    let quoted = quote_remote_path(path);
    let dir = std::path::Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let setup = if dir.is_empty() || dir == "/" {
        String::new()
    } else {
        format!("mkdir -p {} && ", quote_remote_path(&dir))
    };
    let out = ssh_run(target, &format!("{setup}cat > {quoted}"), Some(content), SSH_TIMEOUT_SECS, None).await?;
    if out.code != 0 {
        return Err(format!("写入文件失败: {}", first_line(&out.stderr).unwrap_or_else(|| "未知错误".to_string())));
    }
    Ok(())
}

/// 删除文件：test -f/-d 守卫（只删文件）+ rm
pub async fn ssh_delete_file(target: &SshTarget, path: &str) -> Result<(), String> {
    let quoted = quote_remote_path(path);
    let check = ssh_run(target, &format!("test -f {quoted} && echo FILE || echo NONE"), None, SSH_TIMEOUT_SECS, None).await?;
    if check.stdout.trim() != "FILE" {
        let dir_check = ssh_run(target, &format!("test -d {quoted} && echo DIR || echo MISSING"), None, SSH_TIMEOUT_SECS, None).await?;
        return Err(if dir_check.stdout.trim() == "DIR" {
            "只允许删除普通文件（目录请用终端命令）".to_string()
        } else {
            format!("文件不存在: {path}")
        });
    }
    let out = ssh_run(target, &format!("rm -f {quoted}"), None, SSH_TIMEOUT_SECS, None).await?;
    if out.code != 0 {
        return Err(format!("删除文件失败: {}", first_line(&out.stderr).unwrap_or_else(|| "未知错误".to_string())));
    }
    Ok(())
}

/// 创建目录（mkdir -p）
pub async fn ssh_create_dir(target: &SshTarget, path: &str) -> Result<(), String> {
    let out = ssh_run(target, &format!("mkdir -p {}", shell_quote(path)), None, SSH_TIMEOUT_SECS, None).await?;
    if out.code != 0 {
        return Err(format!("创建目录失败: {}", first_line(&out.stderr).unwrap_or_else(|| "未知错误".to_string())));
    }
    Ok(())
}

/// 重命名/移动（目标已存在拒绝，镜像本地 fs_rename 语义）
pub async fn ssh_rename(target: &SshTarget, from: &str, to: &str) -> Result<(), String> {
    let exists = ssh_run(target, &format!("test -e {} && echo Y || echo N", shell_quote(to)), None, SSH_TIMEOUT_SECS, None).await?;
    if exists.stdout.trim() == "Y" {
        return Err(format!("目标已存在: {to}"));
    }
    let out = ssh_run(
        target,
        &format!("mv {} {}", quote_remote_path(from), quote_remote_path(to)),
        None,
        SSH_TIMEOUT_SECS,
        None,
    )
    .await?;
    if out.code != 0 {
        return Err(format!("重命名失败: {}", first_line(&out.stderr).unwrap_or_else(|| "未知错误".to_string())));
    }
    Ok(())
}

/// glob：find 全列 + 本地正则匹配（ Hetu GlobAsync 同构；上限 500）
pub async fn ssh_glob(target: &SshTarget, root: &str, pattern: &str, limit: usize, matcher: &Regex, skip_dirs: &[&str]) -> Result<GlobResult, String> {
    let out = ssh_run(
        target,
        &format!("find {} -type f 2>/dev/null | head -n 20000", quote_remote_path(root)),
        None,
        SSH_TIMEOUT_SECS,
        None,
    )
    .await?;
    if out.code != 0 {
        return Err(format!("find 失败: {}", first_line(&out.stderr).unwrap_or_else(|| "未知错误".to_string())));
    }
    let mut entries: Vec<GlobEntry> = Vec::new();
    let mut truncated = false;
    for line in out.stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(rel) = relative_to_root(root, line) else { continue };
        let name = rel.rsplit('/').next().unwrap_or("");
        if skip_dirs.contains(&name) {
            continue;
        }
        if !matcher.is_match(&rel) {
            continue;
        }
        if entries.len() >= limit {
            truncated = true;
            break;
        }
        entries.push(GlobEntry { path: rel, is_dir: false });
    }
    Ok(GlobResult { entries, truncated, root: root.to_string() })
}

/// grep：grep -rnE 解析（Hetu GrepAsync 同构）
pub async fn ssh_grep(
    target: &SshTarget,
    root: &str,
    pattern: &str,
    glob: Option<&str>,
    case_sensitive: bool,
    limit: usize,
    skip_dirs: &[&str],
) -> Result<GrepResult, String> {
    let pattern_arg = shell_quote(pattern);
    let case_flag = if case_sensitive { "" } else { "i" };
    let glob_args = match glob.map(str::trim).filter(|g| !g.is_empty()) {
        Some(g) => format!(" --include {}", shell_quote(&normalize_glob_for_find(g))),
        None => String::new(),
    };
    let skip_prunes: String = skip_dirs
        .iter()
        .map(|d| format!(" --exclude-dir={}", shell_quote(d)))
        .collect();
    let command = format!(
        "grep -rnE{case_flag}I{glob_args}{skip_prunes} -e {pattern_arg} {} 2>/dev/null | head -n {}",
        quote_remote_path(root),
        limit.saturating_mul(2)
    );
    let out = ssh_run(target, &command, None, SSH_TIMEOUT_SECS, None).await?;
    let mut hits: Vec<GrepHit> = Vec::new();
    let mut skipped = 0usize;
    for raw in out.stdout.lines() {
        let line = raw.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        // 形如 /abs/root/src/a.rs:12: code —— 文件路径本身可能含冒号，用「数字行号」锚定第二段
        let Some(rel_end) = find_line_no_split(line) else { continue };
        let (path_part, rest) = line.split_at(rel_end);
        let rest = &rest[1..]; // 跳过 ':'
        let Some((line_no_str, text)) = rest.split_once(':') else { continue };
        let Ok(line_no) = line_no_str.trim().parse::<usize>() else { continue };
        let Some(rel) = relative_to_root(root, path_part) else { continue };
        if rel.is_empty() {
            skipped += 1;
            continue;
        }
        let mut text = text.trim().to_string();
        if text.chars().count() > 400 {
            text = format!("{}…", text.chars().take(400).collect::<String>());
        }
        hits.push(GrepHit { path: rel, line: line_no, text });
        if hits.len() >= limit {
            break;
        }
    }
    // grep 整体失败（exit 2 = 出错；exit 1 = 无匹配）
    if hits.is_empty() && out.code >= 2 && !out.stderr.trim().is_empty() {
        skipped += 1;
    }
    Ok(GrepResult { hits, truncated: false, skipped_files: skipped, root: root.to_string() })
}

/// 找 `:数字:` 行号段的第一个冒号位置（返回路径结束索引）
pub(crate) fn find_line_no_split(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut i = 1;
    while i < bytes.len() - 1 {
        if bytes[i] == b':' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && j < bytes.len() && bytes[j] == b':' {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// glob → find --include 形态（Hetu NormalizeGlobForFind 简版：去 **/ 前缀差异）
fn normalize_glob_for_find(glob: &str) -> String {
    let g = glob.replace('\\', "/").trim_start_matches('/').to_string();
    g
}

fn first_line(s: &str) -> Option<String> {
    s.lines()
        .map(str::trim)
        .find(|l| {
            !l.is_empty()
                // ssh 横幅/告警不算错误（post-quantum 提示等），真实错误在其后
                && !l.starts_with("**")
                && !l.to_lowercase().starts_with("warning:")
        })
        .or_else(|| s.lines().map(str::trim).find(|l| !l.is_empty()))
        .map(str::to_string)
}

// ===== 复杂编辑（edit 工具 = 读→替换→写回）=====

/// 远端精确替换（Hetu ApplyPatchAsync 同构）：唯一性校验 + 全文写回
pub async fn ssh_apply_edit(
    target: &SshTarget,
    path: &str,
    search: &str,
    replace: &str,
    replace_all: bool,
) -> Result<(usize, i64), String> {
    let read = ssh_run(target, &format!("cat {}", quote_remote_path(path)), None, SSH_TIMEOUT_SECS, None).await?;
    if read.code != 0 {
        return Err(format!("读取文件失败: {}", first_line(&read.stderr).unwrap_or_else(|| "未知错误".to_string())));
    }
    let original = read.stdout;
    let matches = original.matches(search).count();
    if matches == 0 {
        return Err("未找到 search 片段，文件内容未被修改（请先 read_file 确认原文）".into());
    }
    if matches > 1 && !replace_all {
        return Err(format!("search 片段匹配到 {matches} 处，请扩大上下文使其唯一，或指定 replaceAll=true"));
    }
    let updated = if replace_all {
        original.replace(search, replace)
    } else {
        original.replacen(search, replace, 1)
    };
    ssh_write_file(target, path, &updated).await?;
    Ok((matches, updated.len() as i64 - original.len() as i64))
}

/// git 只读白名单（v1：SSH 工作区仅允许只读 git 子命令）
pub fn is_readonly_git_args(args: &[&str]) -> bool {
    let Some(first) = args.first() else { return false };
    matches!(
        *first,
        "status" | "log" | "diff" | "branch" | "show" | "rev-parse" | "symbolic-ref" | "config" | "numstat" | "remote" | "ls-files"
    )
}

/// 便捷入口：解析工作区 + cd root 已由 ssh_run 处理，这里补只读 git 路由
pub async fn ssh_git(ws: &SshTarget, args: &[&str]) -> Result<String, String> {
    if !is_readonly_git_args(args) {
        return Err("SSH 工作区 v1 仅支持只读 Git 操作（status/log/diff/branch 等），写操作请用终端或本地工作区".into());
    }
    let mut cmd = format!("git");
    for a in args {
        cmd.push(' ');
        cmd.push_str(&shell_quote(a));
    }
    let out = ssh_run(ws, &cmd, None, SSH_TIMEOUT_SECS, None).await?;
    if out.code != 0 {
        let combined = out.combined();
        if combined.to_lowercase().contains("not a git repository") {
            return Err("GIT_NOT_REPO".into());
        }
        return Err(format!("git {} 失败：{}", args.first().unwrap_or(&""), combined.trim()));
    }
    Ok(out.stdout)
}

/// kv 代理连通性自检用（测试断言代理确实生效）
pub async fn ssh_whoami(target: &SshTarget) -> Result<String, String> {
    let out = ssh_run(target, "whoami", None, SSH_TIMEOUT_SECS, None).await?;
    if out.code != 0 {
        return Err(format!("whoami 失败: {}", first_line(&out.stderr).unwrap_or_else(|| "未知错误".to_string())));
    }
    Ok(out.stdout.trim().to_string())
}

/// notify 表复用 conversations.db 连接；这里仅为占位避免未用 import（rusqlite params 用于未来扩展）
#[allow(dead_code)]
fn _unused_params_marker() {
    let _ = params![];
}

// ===== Tauri 命令 =====

/// 保存 SSH 密码（0600 认证文件；UI 表单用）
#[tauri::command]
pub async fn ssh_store_password_cmd(
    workspace: String,
    password: String,
) -> Result<(), String> {
    let target = parse_ssh_workspace(&workspace)?;
    tauri::async_runtime::spawn_blocking(move || store_ssh_password(&target, &password))
        .await
        .map_err(|e| e.to_string())?
}

/// 连通性探测：远端执行 `echo ok && whoami && uname -s`（新建工作区表单「测试连接」用）
#[tauri::command]
pub async fn ssh_probe(workspace: String) -> Result<String, String> {
    let target = parse_ssh_workspace(&workspace)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        rt.block_on(async {
            let out = ssh_run(&target, "echo ok && whoami && uname -s", None, 30, None).await?;
            if out.code != 0 {
                return Err(format!("连接失败: {}", first_line(&out.stderr).unwrap_or_else(|| "未知错误".to_string())));
            }
            Ok(out.stdout.trim().to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
