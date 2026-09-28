//! MCP（Model Context Protocol）集成——LiveAgent
//! `crates/agent-gui/src-tauri/src/commands/integration/mcp.rs` 同构移植。
//!
//! 与 LiveAgent 原实现的差异（本期范围）：
//! - **无 OAuth**：`auth` 字段、401 被动刷新链、mcp_oauth 服务全部不移植
//!   （前端 isOauthServer 一律按 false 处理，静态 `headers` 照常生效）；
//! - **无 run_id 取消**：LA 的 `mcp_call_tool` 支持 ShellRunRegistry + tokio::select
//!   取消，本项目无该设施，调用一律跑满；
//! - **存储**：`~/.ReinAgent/mcp_servers.json` 单文件（LA 为 SQLite 表）；
//! - **无 system_proxy 集成**：ureq 默认读取环境变量代理，无应用级代理配置
//!   与 proxy_revision 重建逻辑；
//! - **全局状态**：本项目不走 `app.manage()`，用进程级 `OnceLock<McpRuntimeManager>`
//!   单例（tauri-free）；
//! - 客户端名 `ReinAgent`（LA 为 `LiveAgent`）；
//! - 协议版本候选序列、stdio 的 cmd.exe 转发（issue #205 教训）、stderr 环形
//!   tail、SessionExpired404 重试、三传输（stdio / streamable-http / legacy
//!   http+sse）语义、锁纪律（map 锁不跨 client 锁持有）均与 LA 一致。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const LEGACY_SSE_ENDPOINT_WAIT_MS: u64 = 3_000;
const STDERR_TAIL_MAX_LINES: usize = 200;

// ---------------------------------------------------------------------------
// 服务器配置（~/.ReinAgent/mcp_servers.json）
// ---------------------------------------------------------------------------

/// 与前端 `McpServerConfig`（camelCase）一一对应。旧版 JSON（含 `name`、缺
/// `description/docsUrl/cwd/messageUrl` 等）靠 serde 缺省值兼容读取：
/// Option 字段缺省 = None，未知字段（如旧 `name`）自动忽略，不做数据迁移。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub docs_url: Option<String>,
    pub enabled: bool,
    /// stdio | http | sse（缺省 stdio）
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// legacy SSE：endpoint 事件不可用时的 POST 地址覆盖
    #[serde(default)]
    pub message_url: Option<String>,
}

impl McpServerConfig {
    fn transport(&self) -> &str {
        self.transport.as_deref().unwrap_or("stdio")
    }

    fn timeout(&self) -> Duration {
        let ms = self.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(1);
        Duration::from_millis(ms)
    }

    fn url_trimmed(&self) -> Option<&str> {
        self.url
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
    }

    fn message_url_trimmed(&self) -> Option<&str> {
        self.message_url
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
    }
}

fn servers_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    Path::new(&home).join(".ReinAgent").join("mcp_servers.json")
}

fn load_servers() -> Vec<McpServerConfig> {
    let Ok(text) = std::fs::read_to_string(servers_path()) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_servers(servers: &[McpServerConfig]) -> Result<(), String> {
    let path = servers_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text =
        serde_json::to_string_pretty(servers).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写入失败: {e}"))
}

// ---------------------------------------------------------------------------
// URL 辅助（无 url crate 依赖的轻量解析，覆盖 legacy SSE 场景）
// ---------------------------------------------------------------------------

/// 校验并归一 http(s) URL（LA 用 Url::parse；这里收紧为必须显式 http(s) 前缀）。
fn validate_http_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Ok(trimmed.to_string())
    } else {
        Err(format!("MCP url 无效：必须是 http(s) 地址，得到 `{trimmed}`"))
    }
}

/// 截取 `scheme://host[:port]` 前缀。
fn url_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some(format!("{scheme}://{}", &rest[..host_end]))
}

/// 提取 URL 路径部分（含前导 `/`，不含查询串/锚点）。
fn url_path(url: &str) -> &str {
    let rest = match url.find("://") {
        Some(idx) => &url[idx + 3..],
        None => url,
    };
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    match rest.find('/') {
        Some(start) if start < end => &rest[start..end],
        _ => "/",
    }
}

/// 相对地址解析（legacy SSE endpoint 事件与 messageUrl 覆盖共用）：
/// 绝对地址原样；`/path` 挂 origin；其余按 base 目录解析。
fn join_url(base: &str, rel: &str) -> Option<String> {
    let rel = rel.trim();
    if rel.is_empty() {
        return None;
    }
    if rel.contains("://") {
        return Some(rel.to_string());
    }
    let origin = url_origin(base)?;
    if let Some(path) = rel.strip_prefix('/') {
        return Some(format!("{origin}/{path}"));
    }
    let base = base.split(['?', '#']).next().unwrap_or(base);
    let dir = match base.rfind('/') {
        // rfind 落在 origin 之外时取目录段；否则目录就是 origin 本身
        Some(idx) if base[..idx].contains("://") => base[..=idx].to_string(),
        _ => format!("{origin}/"),
    };
    Some(format!("{dir}{rel}"))
}

// ---------------------------------------------------------------------------
// stdio 子进程构建（Windows .cmd/.bat 须经 cmd.exe 转发，LA issue #205）
// ---------------------------------------------------------------------------

fn expand_tilde_path(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" || trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        if let Some(home) = dirs::home_dir() {
            if trimmed == "~" {
                return home;
            }
            return home.join(&trimmed[2..]);
        }
    }
    PathBuf::from(trimmed)
}

fn maybe_augment_macos_path(command: &mut Command) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let mut extra: Vec<String> = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ];
    if let Some(home) = dirs::home_dir() {
        extra.push(home.join(".local/bin").to_string_lossy().into_owned());
    }
    let current = std::env::var("PATH").unwrap_or_default();
    let mut current_parts: Vec<String> = current
        .split(':')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect();
    let mut out: Vec<String> = Vec::new();
    for p in extra.drain(..) {
        if current_parts.iter().any(|existing| existing == &p) {
            continue;
        }
        out.push(p);
    }
    out.append(&mut current_parts);
    command.env("PATH", out.join(":"));
}

fn build_stdio_command(cmd: &str, args: &[String], cwd: Option<&Path>) -> Command {
    let program = resolve_program_path_with_current_dir(cmd, cwd);

    #[cfg(windows)]
    {
        if is_windows_batch_program(&program) {
            use std::os::windows::process::CommandExt;

            // .cmd/.bat 无法被 CreateProcess 直接执行，需经 cmd.exe 转发。
            // /C 后的命令行必须用 raw_arg 原样传入：arg() 会按 MSVCRT 规则
            // 把内嵌引号转义成 `\"`，cmd.exe 不识别该转义，子进程瞬退，
            // stdin 写入报 os error 232（LA issue #205）。
            // /E:ON 保证命令扩展可用（`%%cd:~,` 防展开 hack 依赖它），
            // /V:OFF 关闭延迟展开，防止参数里的 `!VAR!` 被替换。
            let mut command = Command::new("cmd.exe");
            command
                .arg("/E:ON")
                .arg("/V:OFF")
                .arg("/D")
                .arg("/S")
                .arg("/C");
            command.raw_arg(windows_cmd_c_argument(&program, args));
            return command;
        }
    }

    let mut command = Command::new(program);
    command.args(args);
    command
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_windows_batch_program(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
}

/// 组装 `cmd.exe /S /C` 之后的整段命令行：外层再包一对引号，`/S` 语义下
/// cmd 仅剥掉首尾引号，剩余部分按原样执行。
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_cmd_c_argument(program: &Path, args: &[String]) -> String {
    let line = std::iter::once(program.to_string_lossy().into_owned())
        .chain(args.iter().cloned())
        .map(|value| windows_cmd_quote_arg(&value))
        .collect::<Vec<_>>()
        .join(" ");
    format!("\"{line}\"")
}

/// 引号包裹单个参数，转义规则对齐 std `sys/args/windows.rs::append_bat_arg`：
/// - 内嵌引号前的反斜杠补齐至 2n 再把引号翻倍（cmd.exe 不识别 `\"`）；
/// - 收尾引号前的尾部反斜杠同样翻倍，防止 `C:\dir\` 这类参数把闭合引号
///   转义掉、与后一个参数粘连；
/// - `%`/`\r` 前插入 `%%cd:~,` no-op（yt-dlp hack，依赖 `/E:ON`），阻止
///   `%VAR%` 被 cmd 当环境变量展开，子进程仍收到原文。
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_cmd_quote_arg(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    let mut backslashes = 0usize;
    for ch in value.chars() {
        if ch == '\\' {
            backslashes += 1;
        } else {
            if ch == '"' {
                escaped.extend(std::iter::repeat_n('\\', backslashes));
                escaped.push('"');
            } else if ch == '%' || ch == '\r' {
                escaped.push_str("%%cd:~,");
            }
            backslashes = 0;
        }
        escaped.push(ch);
    }
    escaped.extend(std::iter::repeat_n('\\', backslashes));
    escaped.push('"');
    escaped
}

/// Windows 下按 PATHEXT 解析裸程序名（`npx` → `npx.cmd`），使 cmd.exe 转发
/// 与批量脚本命中成为可能；非 Windows 直接展开 `~`。
fn resolve_program_path_with_current_dir(raw: &str, current_dir: Option<&Path>) -> PathBuf {
    let expanded = expand_tilde_path(raw);

    #[cfg(windows)]
    {
        resolve_windows_program_path(raw, &expanded, current_dir).unwrap_or(expanded)
    }

    #[cfg(not(windows))]
    {
        expanded
    }
}

#[cfg(windows)]
fn resolve_windows_program_path(
    raw: &str,
    expanded: &Path,
    current_dir: Option<&Path>,
) -> Option<PathBuf> {
    if expanded.is_absolute() || raw.contains('\\') || raw.contains('/') {
        let candidate = if expanded.is_absolute() {
            expanded.to_path_buf()
        } else if let Some(current_dir) = current_dir {
            current_dir.join(expanded)
        } else {
            expanded.to_path_buf()
        };
        return resolve_windows_path_candidate(&candidate);
    }

    if let Some(current_dir) = current_dir {
        for candidate in windows_program_names(raw) {
            let path = current_dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }

    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for candidate in windows_program_names(raw) {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(windows)]
fn resolve_windows_path_candidate(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    if path.extension().is_some() {
        return None;
    }
    for ext in windows_path_extensions() {
        let candidate = path.with_extension(ext.trim_start_matches('.'));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
fn windows_program_names(raw: &str) -> Vec<String> {
    if Path::new(raw).extension().is_some() {
        return vec![raw.to_string()];
    }
    windows_path_extensions()
        .into_iter()
        .map(|ext| format!("{raw}{ext}"))
        .collect()
}

#[cfg(windows)]
fn windows_path_extensions() -> Vec<String> {
    let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let mut out: Vec<String> = raw
        .split(';')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.starts_with('.') {
                value.to_string()
            } else {
                format!(".{value}")
            }
        })
        .collect();
    if out.is_empty() {
        out.extend([".COM", ".EXE", ".BAT", ".CMD"].map(String::from));
    }
    out
}

// ---------------------------------------------------------------------------
// 子进程组与进程树终止（对齐 LA runtime/process.rs；Windows 参考 fs_cmd.rs）
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn configure_child_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn configure_child_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(any(unix, windows)))]
fn configure_child_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn signal_process_tree_by_pid(pid: u32, force: bool) {
    let signal = if force { "-KILL" } else { "-TERM" };
    let process_group = format!("-{pid}");
    let _ = Command::new("kill")
        .arg(signal)
        .arg("--")
        .arg(process_group)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(windows)]
fn signal_process_tree_by_pid(pid: u32, _force: bool) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(any(unix, windows)))]
fn signal_process_tree_by_pid(_pid: u32, _force: bool) {}

/// best-effort 进程树终止（对齐 LA 同名函数）。
fn kill_child_process_tree_best_effort(child: &mut Child) {
    signal_process_tree_by_pid(child.id(), true);
    let _ = child.kill();
    let _ = child.wait();
}

// ---------------------------------------------------------------------------
// JSON-RPC 公共层
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

#[derive(Debug)]
enum McpTransportError {
    Message(String),
    /// streamable http 会话过期（404 且带过 session）：上层 reset + re-init +
    /// 重试一次。
    SessionExpired404,
}

impl McpTransportError {
    fn msg(s: impl Into<String>) -> Self {
        Self::Message(s.into())
    }
}

fn parse_jsonrpc_result(method: &str, id: u64, msg: &Value) -> Result<Value, String> {
    let msg_id = msg.get("id");
    if msg_id != Some(&json!(id)) {
        return Err(format!(
            "MCP response id mismatch: method={method} id={id} msg={msg}"
        ));
    }

    if let Some(err) = msg.get("error") {
        let rpc_err: JsonRpcError = serde_json::from_value(err.clone()).unwrap_or(JsonRpcError {
            code: -1,
            message: err.to_string(),
        });
        return Err(format!(
            "MCP call failed: method={method} code={} message={}",
            rpc_err.code, rpc_err.message
        ));
    }

    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

/// 从 SSE 流里读出 id 匹配的 JSON-RPC 响应（streamable http 以 event-stream
/// 返回时用）。
fn read_sse_for_matching_id<R: BufRead>(
    reader: &mut R,
    method: &str,
    id: u64,
) -> Result<Value, String> {
    let mut line = String::new();
    let mut data_lines: Vec<String> = Vec::new();

    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read the SSE stream: {e}"))?;
        if n == 0 {
            return Err(format!(
                "The SSE stream closed before a response was received: method={method} id={id}"
            ));
        }

        let l = line.trim_end_matches(['\r', '\n']);
        if l.is_empty() {
            // dispatch
            if data_lines.is_empty() {
                continue;
            }

            let data = data_lines.join("\n");
            data_lines.clear();

            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                if v.get("id") == Some(&json!(id)) {
                    return Ok(v);
                }
            }

            continue;
        }

        if l.starts_with(':') {
            continue;
        }
        if l.strip_prefix("event:").is_some() {
            continue;
        }
        if let Some(rest) = l.strip_prefix("data:") {
            data_lines.push(rest.trim_start().to_string());
            continue;
        }
        if l.strip_prefix("id:").is_some() {
            // Ignore SSE event id.
            continue;
        }
    }
}

fn append_stderr_tail(tail: &Arc<Mutex<Vec<String>>>, line: String) {
    if line.is_empty() {
        return;
    }
    if let Ok(mut buf) = tail.lock() {
        buf.push(line);
        if buf.len() > STDERR_TAIL_MAX_LINES {
            let drain = buf.len() - STDERR_TAIL_MAX_LINES;
            buf.drain(0..drain);
        }
    }
}

// ---------------------------------------------------------------------------
// Stdio 传输（spawn 子进程 + 行协议）
// ---------------------------------------------------------------------------

struct StdioTransport {
    child: Child,
    stdin: ChildStdin,
    stdout_rx: mpsc::Receiver<String>,
    stderr_tail: Arc<Mutex<Vec<String>>>,
}

impl StdioTransport {
    fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        let cmd = config.command.trim();
        if cmd.is_empty() {
            return Err("MCP server command 不能为空（transport=stdio）".to_string());
        }

        let cwd = config
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(expand_tilde_path);

        let mut command = build_stdio_command(cmd, &config.args, cwd.as_deref());
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        maybe_augment_macos_path(&mut command);
        configure_child_process_group(&mut command);
        // server 配置的 env 最后写，保持最高优先级。
        if let Some(env) = &config.env {
            command.envs(env);
        }
        if let Some(cwd) = &cwd {
            command.current_dir(cwd);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("启动 MCP server 失败：{e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法获取 MCP server stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法获取 MCP server stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法获取 MCP server stderr".to_string())?;

        let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        {
            let tail = stderr_tail.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) => {
                            let l = line.trim_end().to_string();
                            append_stderr_tail(&tail, l);
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if tx.send(trimmed.to_string()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            stdout_rx: rx,
            stderr_tail,
        })
    }

    fn stderr_summary(&self) -> String {
        if let Ok(buf) = self.stderr_tail.lock() {
            if buf.is_empty() {
                return "".to_string();
            }
            let joined = buf.join("\n");
            return format!("\n\n--- MCP server stderr (tail) ---\n{joined}");
        }
        "".to_string()
    }

    fn ensure_running(&mut self) -> Result<(), String> {
        if let Some(status) = self.child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "MCP server exited unexpectedly: status={status}{}",
                self.stderr_summary()
            ));
        }
        Ok(())
    }

    fn send_line(&mut self, line: &str) -> Result<(), String> {
        self.ensure_running()?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| {
                format!(
                    "Failed to write to MCP server stdin: {e}{}",
                    self.stderr_summary()
                )
            })
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let req = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        self.send_line(&req.to_string())
    }

    fn request(
        &mut self,
        timeout: Duration,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.ensure_running()?;

        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        self.send_line(&req.to_string())?;

        // 逐行读直到匹配 id（忽略通知/其他 id），超时按 config.timeoutMs。
        let deadline = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(Instant::now);
        loop {
            let now = Instant::now();
            let remaining = deadline.saturating_duration_since(now);
            if remaining.is_zero() {
                return Err(format!(
                    "MCP request timed out: method={method} id={id}{}",
                    self.stderr_summary()
                ));
            }

            let line = self.stdout_rx.recv_timeout(remaining).map_err(|e| {
                format!(
                    "Failed to read MCP server stdout or the read timed out: {e}{}",
                    self.stderr_summary()
                )
            })?;

            let msg: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue, // stdout 上的非 JSON 输出（不应发生，忽略）。
            };

            if msg.get("id") == Some(&json!(id)) {
                return parse_jsonrpc_result(method, id, &msg)
                    .map_err(|e| format!("{e}{}", self.stderr_summary()));
            }
        }
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        kill_child_process_tree_best_effort(&mut self.child);
    }
}

// ---------------------------------------------------------------------------
// Streamable HTTP 传输（POST endpoint + 会话/协议版本头）
// ---------------------------------------------------------------------------

/// 构建 ureq client：`http_status_as_error(false)` 让 4xx/5xx 以正常响应返回，
/// 由上层显式分支（404 会话过期等）；connect 超时固定 10s，总超时可选。
fn build_http_client(total_timeout: Option<Duration>) -> Result<ureq::Agent, String> {
    let mut config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(10)));
    if let Some(timeout) = total_timeout {
        config = config.timeout_global(Some(timeout));
    }
    Ok(config.build().into())
}

struct HttpTransport {
    endpoint: String,
    client: ureq::Agent,
    headers: BTreeMap<String, String>,
    session_id: Option<String>,
    protocol_version: Option<String>,
}

impl HttpTransport {
    fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        let url = config
            .url_trimmed()
            .ok_or_else(|| "MCP http transport 需要 url".to_string())?;
        let endpoint = validate_http_url(url)?;
        let client = build_http_client(Some(config.timeout()))?;

        Ok(Self {
            endpoint,
            client,
            headers: config.headers.clone().unwrap_or_default(),
            session_id: None,
            protocol_version: None,
        })
    }

    fn reset_session(&mut self) {
        self.session_id = None;
        self.protocol_version = None;
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let req = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        let mut builder = self.client.post(&self.endpoint);
        for (k, v) in &self.headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
        builder = builder.header("Accept", "application/json, text/event-stream");
        if let Some(v) = &self.protocol_version {
            builder = builder.header("MCP-Protocol-Version", v);
        }
        if let Some(sid) = &self.session_id {
            builder = builder.header("MCP-Session-Id", sid);
        }

        let resp = builder
            .send_json(&req)
            .map_err(|e| format!("MCP HTTP notify failed: method={method} err={e}"))?;

        if !resp.status().is_success() {
            return Err(format!(
                "MCP HTTP notify failed: method={method} status={}",
                resp.status().as_u16()
            ));
        }

        Ok(())
    }

    fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, McpTransportError> {
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        let mut builder = self.client.post(&self.endpoint);
        for (k, v) in &self.headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
        builder = builder.header("Accept", "application/json, text/event-stream");

        // 协商后的协议版本；initialize 请求带上本次尝试的版本。
        if let Some(v) = &self.protocol_version {
            builder = builder.header("MCP-Protocol-Version", v);
        } else if method == "initialize" {
            if let Some(v) = req
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str)
            {
                builder = builder.header("MCP-Protocol-Version", v);
            }
        }

        // initialize 之外才挂 session id。
        if method != "initialize" {
            if let Some(sid) = &self.session_id {
                builder = builder.header("MCP-Session-Id", sid);
            }
        }

        let resp = builder.send_json(&req).map_err(|e| {
            McpTransportError::msg(format!("MCP HTTP request failed: method={method} err={e}"))
        })?;

        if resp.status().as_u16() == 404
            && self.session_id.is_some()
            && method != "initialize"
        {
            return Err(McpTransportError::SessionExpired404);
        }

        if !resp.status().is_success() {
            return Err(McpTransportError::msg(format!(
                "MCP HTTP request failed: method={method} status={}",
                resp.status().as_u16()
            )));
        }

        let session_header = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();

        let msg: Value = if ct.starts_with("text/event-stream") {
            let mut reader = BufReader::new(resp.into_body().into_reader());
            read_sse_for_matching_id(&mut reader, method, id).map_err(McpTransportError::msg)?
        } else {
            let body = resp.into_body().read_to_string().map_err(|e| {
                McpTransportError::msg(format!("Failed to read the MCP HTTP response: {e}"))
            })?;
            serde_json::from_str(&body).map_err(|e| {
                McpTransportError::msg(format!(
                    "Failed to parse MCP HTTP JSON: method={method} err={e} body={body}"
                ))
            })?
        };

        let result = parse_jsonrpc_result(method, id, &msg).map_err(McpTransportError::msg)?;

        if method == "initialize" {
            if let Some(sid) = session_header {
                self.session_id = Some(sid);
            }

            if let Some(pv) = result.get("protocolVersion").and_then(Value::as_str) {
                self.protocol_version = Some(pv.to_string());
            } else if let Some(pv) = req
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str)
            {
                self.protocol_version = Some(pv.to_string());
            }
        }

        Ok(result)
    }
}

// ---------------------------------------------------------------------------
// Legacy HTTP+SSE 传输（GET 长连 + endpoint 事件 + POST message 地址）
// ---------------------------------------------------------------------------

struct SseTransport {
    sse_url: String,
    message_url_override: Option<String>,
    post_url: Arc<Mutex<Option<String>>>,
    client_post: ureq::Agent,
    headers: BTreeMap<String, String>,
    rx: mpsc::Receiver<Value>,
    stop: Arc<AtomicBool>,
    _thread: Option<std::thread::JoinHandle<()>>,
}

impl SseTransport {
    fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        let url = config
            .url_trimmed()
            .ok_or_else(|| "MCP sse transport 需要 url（SSE endpoint）".to_string())?;
        let sse_url = validate_http_url(url)?;

        let headers = config.headers.clone().unwrap_or_default();

        let message_url_override = match config.message_url_trimmed() {
            None => None,
            // 支持相对地址。
            Some(raw) => Some(
                join_url(&sse_url, raw)
                    .ok_or_else(|| format!("messageUrl 无效：{raw}"))?,
            ),
        };

        // GET 长连不设总超时（会掐断事件流）；POST 总超时 = timeoutMs。语义同 LA。
        let client_get = build_http_client(None)?;
        let client_post = build_http_client(Some(config.timeout()))?;

        let post_url: Arc<Mutex<Option<String>>> =
            Arc::new(Mutex::new(message_url_override.clone()));

        let (tx, rx) = mpsc::channel::<Value>();
        let stop = Arc::new(AtomicBool::new(false));

        let thread_sse_url = sse_url.clone();
        let thread_post_url = post_url.clone();
        let thread_headers = headers.clone();
        let thread_stop = stop.clone();
        let thread_client = client_get.clone();

        // 失败重连用退避：固定 1s 会在上游不可达时以每秒一次的频率反复建连
        //（DNS + TCP + TLS 握手），而"配置了 SSE server 却连不上"时这个循环是
        // 常驻的。连上一次即复位，避免把瞬时抖动放大成持续退避。
        const SSE_RECONNECT_MIN: Duration = Duration::from_secs(1);
        const SSE_RECONNECT_MAX: Duration = Duration::from_secs(30);
        let handle = std::thread::spawn(move || {
            let mut backoff = SSE_RECONNECT_MIN;
            loop {
                if thread_stop.load(Ordering::Relaxed) {
                    break;
                }

                let mut builder = thread_client.get(&thread_sse_url);
                for (k, v) in &thread_headers {
                    builder = builder.header(k.as_str(), v.as_str());
                }
                builder = builder.header("Accept", "text/event-stream");

                let resp = match builder.call() {
                    Ok(r) => {
                        // 建连成功即复位退避：下一次失败重新从最小间隔起。
                        backoff = SSE_RECONNECT_MIN;
                        r
                    }
                    Err(_) => {
                        std::thread::sleep(backoff);
                        backoff = (backoff * 2).min(SSE_RECONNECT_MAX);
                        continue;
                    }
                };

                if !resp.status().is_success() {
                    std::thread::sleep(backoff);
                    backoff = (backoff * 2).min(SSE_RECONNECT_MAX);
                    continue;
                }

                let mut reader = BufReader::new(resp.into_body().into_reader());
                let mut line = String::new();
                let mut event_name: Option<String> = None;
                let mut data_lines: Vec<String> = Vec::new();

                loop {
                    if thread_stop.load(Ordering::Relaxed) {
                        return;
                    }

                    line.clear();
                    let n = match reader.read_line(&mut line) {
                        Ok(n) => n,
                        Err(_) => break,
                    };
                    if n == 0 {
                        break;
                    }

                    let l = line.trim_end_matches(['\r', '\n']);
                    if l.is_empty() {
                        if data_lines.is_empty() {
                            event_name = None;
                            continue;
                        }

                        let data = data_lines.join("\n");
                        data_lines.clear();

                        let ty = event_name.take().unwrap_or_else(|| "message".to_string());

                        if ty == "endpoint" {
                            let raw = data.trim();
                            if raw.is_empty() {
                                continue;
                            }
                            if let Some(u) = join_url(&thread_sse_url, raw) {
                                if let Ok(mut locked) = thread_post_url.lock() {
                                    *locked = Some(u);
                                }
                            }
                            continue;
                        }

                        if let Ok(v) = serde_json::from_str::<Value>(&data) {
                            let _ = tx.send(v);
                        }

                        continue;
                    }

                    if l.starts_with(':') {
                        continue;
                    }
                    if let Some(rest) = l.strip_prefix("event:") {
                        event_name = Some(rest.trim().to_string());
                        continue;
                    }
                    if let Some(rest) = l.strip_prefix("data:") {
                        data_lines.push(rest.trim_start().to_string());
                        continue;
                    }
                }
            }
        });

        Ok(Self {
            sse_url,
            message_url_override,
            post_url,
            client_post,
            headers,
            rx,
            stop,
            _thread: Some(handle),
        })
    }

    fn wait_or_guess_post_url(&self, timeout: Duration) -> Result<String, String> {
        if let Some(u) = &self.message_url_override {
            return Ok(u.clone());
        }

        // endpoint 事件可能来得慢，等一小会儿。
        let wait_ms = timeout.as_millis() as u64;
        let wait_ms = wait_ms.clamp(1, LEGACY_SSE_ENDPOINT_WAIT_MS);
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(wait_ms))
            .unwrap_or_else(Instant::now);

        loop {
            if let Ok(locked) = self.post_url.lock() {
                if let Some(u) = &*locked {
                    return Ok(u.clone());
                }
            }

            if Instant::now() >= deadline {
                break;
            }

            std::thread::sleep(Duration::from_millis(50));
        }

        // Fallback: /sse -> /message
        let path = url_path(&self.sse_url);
        if let Some(prefix) = path.strip_suffix("/sse") {
            if let Some(origin) = url_origin(&self.sse_url) {
                return Ok(format!("{origin}{prefix}/message"));
            }
        }

        Err(
            "No endpoint event was received, and the message endpoint could not be inferred. Please provide Message URL."
                .to_string(),
        )
    }

    fn notify(&mut self, timeout: Duration, method: &str, params: Value) -> Result<(), String> {
        let post_url = self.wait_or_guess_post_url(timeout)?;

        let req = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        let mut builder = self.client_post.post(&post_url);
        for (k, v) in &self.headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
        let resp = builder
            .send_json(&req)
            .map_err(|e| format!("MCP SSE notify failed: method={method} err={e}"))?;

        if !resp.status().is_success() {
            return Err(format!(
                "MCP SSE notify failed: method={method} status={}",
                resp.status().as_u16()
            ));
        }

        Ok(())
    }

    fn request(
        &mut self,
        timeout: Duration,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, McpTransportError> {
        let post_url = self
            .wait_or_guess_post_url(timeout)
            .map_err(McpTransportError::msg)?;

        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        let mut builder = self.client_post.post(&post_url);
        for (k, v) in &self.headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
        let resp = builder.send_json(&req).map_err(|e| {
            McpTransportError::msg(format!("MCP SSE request failed: method={method} err={e}"))
        })?;

        if !resp.status().is_success() {
            return Err(McpTransportError::msg(format!(
                "MCP SSE request failed: method={method} status={}",
                resp.status().as_u16()
            )));
        }

        let deadline = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(Instant::now);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(McpTransportError::msg(format!(
                    "MCP SSE request timed out: method={method} id={id}"
                )));
            }

            let msg = self.rx.recv_timeout(remaining).map_err(|e| {
                McpTransportError::msg(format!(
                    "Failed to wait for the SSE response or the wait timed out: {e}"
                ))
            })?;

            if msg.get("id") == Some(&json!(id)) {
                return parse_jsonrpc_result(method, id, &msg).map_err(McpTransportError::msg);
            }
        }
    }
}

impl Drop for SseTransport {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// 传输分发 + 协议层客户端
// ---------------------------------------------------------------------------

enum McpTransport {
    Stdio(StdioTransport),
    Http(HttpTransport),
    Sse(SseTransport),
}

impl McpTransport {
    fn ensure_running(&mut self) -> Result<(), String> {
        match self {
            McpTransport::Stdio(t) => t.ensure_running(),
            McpTransport::Http(_) | McpTransport::Sse(_) => Ok(()),
        }
    }

    fn stderr_tail(&self) -> Option<String> {
        match self {
            McpTransport::Stdio(t) => {
                let text = t.stderr_summary();
                if text.trim().is_empty() {
                    None
                } else {
                    Some(text)
                }
            }
            McpTransport::Http(_) | McpTransport::Sse(_) => None,
        }
    }

    fn reset_session(&mut self) {
        if let McpTransport::Http(h) = self {
            h.reset_session();
        }
    }

    fn notify(
        &mut self,
        cfg: &McpServerConfig,
        method: &str,
        params: Value,
    ) -> Result<(), McpTransportError> {
        let timeout = cfg.timeout();
        match self {
            McpTransport::Stdio(t) => t.notify(method, params).map_err(McpTransportError::msg),
            McpTransport::Http(t) => t.notify(method, params).map_err(McpTransportError::msg),
            McpTransport::Sse(t) => t
                .notify(timeout, method, params)
                .map_err(McpTransportError::msg),
        }
    }

    fn request(
        &mut self,
        cfg: &McpServerConfig,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, McpTransportError> {
        let timeout = cfg.timeout();
        match self {
            McpTransport::Stdio(t) => t
                .request(timeout, id, method, params)
                .map_err(McpTransportError::msg),
            McpTransport::Http(t) => t.request(id, method, params),
            McpTransport::Sse(t) => t.request(timeout, id, method, params),
        }
    }
}

struct McpClient {
    config: McpServerConfig,
    transport: McpTransport,
    next_id: u64,
    initialized: bool,
}

impl McpClient {
    fn spawn(config: McpServerConfig) -> Result<Self, String> {
        let transport = match config.transport().trim() {
            "http" => McpTransport::Http(HttpTransport::spawn(&config)?),
            "sse" => McpTransport::Sse(SseTransport::spawn(&config)?),
            _ => McpTransport::Stdio(StdioTransport::spawn(&config)?),
        };

        Ok(Self {
            config,
            transport,
            next_id: 1,
            initialized: false,
        })
    }

    fn next_rpc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        id
    }

    /// initialize 握手：协议版本依次降级尝试，成功后补发
    /// `notifications/initialized`（部分 server 不收到该通知不接受后续请求）。
    fn ensure_initialized(&mut self) -> Result<(), String> {
        if self.initialized {
            return Ok(());
        }

        let candidates = [
            "2025-11-25",
            "2025-06-18",
            "2025-03-26",
            "2024-11-05",
            "2024-10-07",
        ];
        let mut last_err: Option<String> = None;

        for v in candidates {
            let init_params = json!({
                "protocolVersion": v,
                "clientInfo": { "name": "ReinAgent", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": {}
            });

            let id = self.next_rpc_id();
            match self
                .transport
                .request(&self.config, id, "initialize", init_params)
            {
                Ok(_) => {
                    let _ = self.transport.notify(
                        &self.config,
                        "notifications/initialized",
                        json!({}),
                    );
                    self.initialized = true;
                    return Ok(());
                }
                Err(McpTransportError::Message(msg)) => {
                    last_err = Some(msg);
                    break;
                }
                Err(McpTransportError::SessionExpired404) => {
                    last_err = Some("Session expired during initialize (404)".to_string());
                    break;
                }
            }
        }

        Err(last_err.unwrap_or_else(|| "initialize failed".to_string()))
    }

    /// streamable http 的会话过期自愈：404 → reset session → 重新 initialize →
    /// 原请求重试一次；仍 404 判 server 不健康。
    fn request_with_retry(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_rpc_id();
        match self.transport.request(&self.config, id, method, params.clone()) {
            Ok(v) => Ok(v),
            Err(McpTransportError::SessionExpired404) => {
                self.transport.reset_session();
                self.initialized = false;
                self.ensure_initialized()?;

                let retry_id = self.next_rpc_id();
                match self.transport.request(&self.config, retry_id, method, params) {
                    Ok(v) => Ok(v),
                    Err(McpTransportError::Message(msg)) => Err(msg),
                    Err(McpTransportError::SessionExpired404) => Err(
                        "MCP session still returned 404 after retry (the server may be unhealthy)"
                            .to_string(),
                    ),
                }
            }
            Err(McpTransportError::Message(msg)) => Err(msg),
        }
    }

    fn tools_list(&mut self) -> Result<Vec<McpToolInfo>, String> {
        self.ensure_initialized()?;
        let result = self.request_with_retry("tools/list", json!({}))?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut out: Vec<McpToolInfo> = Vec::new();
        for t in tools {
            let name = t
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if name.is_empty() {
                continue;
            }
            let description = t
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let input_schema = t
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object" }));

            out.push(McpToolInfo {
                server_id: self.config.id.clone(),
                server_label: self.config.id.clone(),
                name: name.to_string(),
                description,
                input_schema,
            });
        }

        Ok(out)
    }

    fn runtime_status(&mut self) -> McpRuntimeStatus {
        let last_error = self.transport.ensure_running().err();
        McpRuntimeStatus {
            server_id: self.config.id.clone(),
            running: last_error.is_none(),
            initialized: self.initialized,
            transport: self.config.transport().to_string(),
            last_error,
        }
    }

    fn stderr_tail(&self) -> Option<String> {
        self.transport.stderr_tail()
    }

    fn tools_call(
        &mut self,
        tool_name: &str,
        arguments: Value,
    ) -> Result<McpCallToolResponse, String> {
        self.ensure_initialized()?;
        let result = self.request_with_retry(
            "tools/call",
            json!({
                "name": tool_name,
                "arguments": arguments
            }),
        )?;

        let is_error = result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let mut content_out: Vec<McpContent> = Vec::new();
        if let Some(items) = result.get("content").and_then(Value::as_array) {
            for item in items {
                let ty = item.get("type").and_then(Value::as_str).unwrap_or("");
                match ty {
                    "text" => {
                        let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            content_out.push(McpContent::Text {
                                text: text.to_string(),
                            });
                        }
                    }
                    "image" => {
                        let data = item.get("data").and_then(Value::as_str).unwrap_or("");
                        let mime_type = item
                            .get("mimeType")
                            .and_then(Value::as_str)
                            .unwrap_or("application/octet-stream");
                        if !data.is_empty() {
                            content_out.push(McpContent::Image {
                                data: data.to_string(),
                                mime_type: mime_type.to_string(),
                            });
                        }
                    }
                    _ => {
                        // 未知 content 类型：保留 JSON 预览文本，不丢信息。
                        content_out.push(McpContent::Text {
                            text: item.to_string(),
                        });
                    }
                }
            }
        }

        if content_out.is_empty() {
            content_out.push(McpContent::Text {
                text: result.to_string(),
            });
        }

        Ok(McpCallToolResponse {
            content: content_out,
            is_error,
            details: result,
        })
    }
}

// ---------------------------------------------------------------------------
// 前端响应结构
// ---------------------------------------------------------------------------

/// 工具描述（tools/list 投影）。serverLabel 与 LA 一致取 server id。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server_id: String,
    pub server_label: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// 发给前端的工具结果内容块。
///
/// 注意 serde 的坑：enum 上的 `rename_all` 只重命名**变体名**（`Image` →
/// `"image"`），**不作用于变体内部字段**——字段要靠变体上的 `rename_all`
/// 单独声明。漏掉的话 `mime_type` 会原样以 snake_case 出去，而 TS 侧读的是
/// `mimeType`，拿到 undefined 后拼出 `data:undefined;base64,…`。
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpContent {
    Text {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        data: String,
        mime_type: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallToolResponse {
    pub content: Vec<McpContent>,
    pub is_error: bool,
    /// tools/call 的原始 result（前端调试/扩展用）。
    pub details: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeStatus {
    pub server_id: String,
    pub running: bool,
    pub initialized: bool,
    pub transport: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStopServerResponse {
    pub server_id: String,
    pub stopped: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiagnosticToolInfo {
    pub server_id: String,
    pub server_label: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeTestResponse {
    pub server_id: String,
    pub ok: bool,
    /// config | spawn | initialize | tools_list
    pub phase: String,
    pub transport: String,
    pub duration_ms: u128,
    pub running: bool,
    pub initialized: bool,
    pub tools_count: usize,
    pub tools: Vec<McpDiagnosticToolInfo>,
    pub error: Option<String>,
    pub stderr_tail: Option<String>,
}

// ---------------------------------------------------------------------------
// 运行时管理（进程级单例；LA 的 McpRuntimeManager 语义）
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct McpRuntimeManager {
    clients: Mutex<HashMap<String, Arc<Mutex<McpClient>>>>,
}

static RUNTIME: OnceLock<McpRuntimeManager> = OnceLock::new();

fn runtime() -> &'static McpRuntimeManager {
    RUNTIME.get_or_init(McpRuntimeManager::default)
}

fn to_diagnostic_tools(
    tools: Vec<McpToolInfo>,
    include_schema: bool,
) -> Vec<McpDiagnosticToolInfo> {
    tools
        .into_iter()
        .map(|tool| McpDiagnosticToolInfo {
            server_id: tool.server_id,
            server_label: tool.server_label,
            name: tool.name,
            description: tool.description,
            input_schema: include_schema.then_some(tool.input_schema),
        })
        .collect()
}

fn validate_runtime_config(cfg: &McpServerConfig) -> Result<(), String> {
    let id = cfg.id.trim();
    if id.is_empty() {
        return Err("MCP server name cannot be empty".to_string());
    }

    match cfg.transport() {
        "http" | "sse" => {
            let u = cfg.url_trimmed().unwrap_or("");
            if u.is_empty() {
                return Err(format!(
                    "MCP server({id}) transport={} requires url",
                    cfg.transport()
                ));
            }
        }
        _ => {
            if cfg.command.trim().is_empty() {
                return Err(format!("MCP server({id}) transport=stdio requires command"));
            }
        }
    }

    Ok(())
}

fn classify_start_failure(error: &str) -> &'static str {
    if error.contains("启动 MCP server")
        || error.contains("Failed to start")
        || error.contains("No such file")
        || error.contains("os error 2")
    {
        "spawn"
    } else {
        "config"
    }
}

fn run_client_test(
    id: String,
    transport: String,
    start: Instant,
    client: &mut McpClient,
    include_schema: bool,
) -> McpRuntimeTestResponse {
    let mut phase = "tools_list".to_string();
    let tools = match client.tools_list() {
        Ok(tools) => tools,
        Err(error) => {
            let initialized = client.initialized;
            let running = client.transport.ensure_running().is_ok();
            let stderr_tail = client.stderr_tail();
            if !initialized {
                phase = "initialize".to_string();
            }
            return McpRuntimeTestResponse {
                server_id: id,
                ok: false,
                phase,
                transport,
                duration_ms: start.elapsed().as_millis(),
                running,
                initialized,
                tools_count: 0,
                tools: Vec::new(),
                error: Some(error),
                stderr_tail,
            };
        }
    };
    let tools_count = tools.len();
    let initialized = client.initialized;
    let running = client.transport.ensure_running().is_ok();
    let stderr_tail = client.stderr_tail();
    McpRuntimeTestResponse {
        server_id: id,
        ok: true,
        phase: "tools_list".to_string(),
        transport,
        duration_ms: start.elapsed().as_millis(),
        running,
        initialized,
        tools_count,
        tools: to_diagnostic_tools(tools, include_schema),
        error: None,
        stderr_tail,
    }
}

impl McpRuntimeManager {
    // 锁纪律：clients-map 锁只用于 get/insert，绝不跨 client 锁或 spawn 持有。
    // 持 map 锁穿过忙碌 client（长 tools/call）或慢 spawn 会让所有其它 server
    // 的命令排队。两线程以相同配置并发竞争时可能短暂双 spawn，输家的 client
    // 随 Arc 释放被 drop（transport 一并 kill）——相对全局队头阻塞这是正确取舍。
    fn ensure_client(&self, cfg: McpServerConfig) -> Result<Arc<Mutex<McpClient>>, String> {
        let id = cfg.id.trim().to_string();
        validate_runtime_config(&cfg)?;

        let existing = self
            .clients
            .lock()
            .map_err(|_| "MCP 状态锁失败".to_string())?
            .get(&id)
            .cloned();
        if let Some(existing) = existing.as_ref() {
            // 配置变更即重建。同 id 调用在 client 锁上串行（协议流不可共享），
            // 其它 server 不受影响。
            let same_config = existing
                .lock()
                .map(|client| client.config == cfg)
                .unwrap_or(false);
            if same_config {
                return Ok(existing.clone());
            }
        }

        let client = match McpClient::spawn(cfg) {
            Ok(client) => client,
            Err(error) => {
                // 重建失败必须逐出已判定过期的旧 client：mcp_call_tool 直读 map
                // 不经本函数，留着旧 client 会让失效配置下的调用继续走旧通道。
                // 仅在 map 里仍是同一个 Arc 时移除，避免误杀并发换上的新 client。
                if let Some(stale) = existing {
                    if let Ok(mut map) = self.clients.lock() {
                        if map
                            .get(&id)
                            .is_some_and(|current| Arc::ptr_eq(current, &stale))
                        {
                            map.remove(&id);
                        }
                    }
                }
                return Err(error);
            }
        };
        let arc = Arc::new(Mutex::new(client));
        self.clients
            .lock()
            .map_err(|_| "MCP 状态锁失败".to_string())?
            .insert(id, arc.clone());
        Ok(arc)
    }

    fn stop_client(&self, server_id: &str) -> Result<bool, String> {
        let id = server_id.trim();
        if id.is_empty() {
            return Err("server_id cannot be empty".to_string());
        }
        let mut map = self
            .clients
            .lock()
            .map_err(|_| "MCP state lock failed".to_string())?;
        Ok(map.remove(id).is_some())
    }

    fn runtime_status(&self, server_id: &str) -> Result<McpRuntimeStatus, String> {
        let id = server_id.trim().to_string();
        if id.is_empty() {
            return Err("server_id cannot be empty".to_string());
        }
        let map = self
            .clients
            .lock()
            .map_err(|_| "MCP state lock failed".to_string())?;
        let Some(client) = map.get(&id).cloned() else {
            return Ok(McpRuntimeStatus {
                server_id: id,
                running: false,
                initialized: false,
                transport: "unknown".to_string(),
                last_error: None,
            });
        };
        drop(map);
        let mut locked = client
            .lock()
            .map_err(|_| "MCP client lock failed".to_string())?;
        Ok(locked.runtime_status())
    }

    fn test_client(
        &self,
        cfg: McpServerConfig,
        include_schema: bool,
        restart: bool,
        persist: bool,
    ) -> Result<McpRuntimeTestResponse, String> {
        let id = cfg.id.trim().to_string();
        if id.is_empty() {
            return Err("MCP server name cannot be empty".to_string());
        }
        let transport = cfg.transport().to_string();
        let start = Instant::now();

        if restart && persist {
            let _ = self.stop_client(&id);
        }

        if !persist {
            // 非持久模式：临时 client，跑完即弃（不进池）。
            if let Err(error) = validate_runtime_config(&cfg) {
                return Ok(McpRuntimeTestResponse {
                    server_id: id,
                    ok: false,
                    phase: "config".to_string(),
                    transport,
                    duration_ms: start.elapsed().as_millis(),
                    running: false,
                    initialized: false,
                    tools_count: 0,
                    tools: Vec::new(),
                    error: Some(error),
                    stderr_tail: None,
                });
            }
            let mut client = match McpClient::spawn(cfg) {
                Ok(client) => client,
                Err(error) => {
                    let phase = classify_start_failure(&error);
                    return Ok(McpRuntimeTestResponse {
                        server_id: id,
                        ok: false,
                        phase: phase.to_string(),
                        transport,
                        duration_ms: start.elapsed().as_millis(),
                        running: false,
                        initialized: false,
                        tools_count: 0,
                        tools: Vec::new(),
                        error: Some(error),
                        stderr_tail: None,
                    });
                }
            };
            return Ok(run_client_test(
                id,
                transport,
                start,
                &mut client,
                include_schema,
            ));
        }

        let client = match self.ensure_client(cfg) {
            Ok(client) => client,
            Err(error) => {
                let phase = classify_start_failure(&error);
                return Ok(McpRuntimeTestResponse {
                    server_id: id,
                    ok: false,
                    phase: phase.to_string(),
                    transport,
                    duration_ms: start.elapsed().as_millis(),
                    running: false,
                    initialized: false,
                    tools_count: 0,
                    tools: Vec::new(),
                    error: Some(error),
                    stderr_tail: None,
                });
            }
        };

        let mut locked = client
            .lock()
            .map_err(|_| "MCP client lock failed".to_string())?;
        Ok(run_client_test(
            id,
            transport,
            start,
            &mut locked,
            include_schema,
        ))
    }
}

// ---------------------------------------------------------------------------
// IPC 命令（本项目不加 rename_all：JS 侧一律传 camelCase 参数键）
// ---------------------------------------------------------------------------

/// 保存全部服务器配置（前端整表编辑后一次性写盘）。
#[tauri::command]
pub async fn mcp_save_servers(servers: Vec<McpServerConfig>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_servers(&servers))
        .await
        .map_err(|e| format!("mcp_save_servers join failed: {e}"))?
}

/// 列出全部服务器配置。
#[tauri::command]
pub async fn mcp_list_servers() -> Result<Vec<McpServerConfig>, String> {
    Ok(load_servers())
}

/// 枚举全部已启用服务器上的工具（LA 语义：入参为前端传来的全量服务器列表；
/// 部分失败跳过继续，全部失败才 Err）。
#[tauri::command]
pub async fn mcp_list_tools(servers: Vec<McpServerConfig>) -> Result<Vec<McpToolInfo>, String> {
    // 枚举会阻塞（spawn 子进程 / 网络 / 管道），必须 offload。
    let manager = runtime();
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<McpToolInfo> = Vec::new();

        let mut succeeded = 0usize;
        let mut failures: Vec<String> = Vec::new();
        for cfg in servers.into_iter().filter(|s| s.enabled) {
            let server_id = cfg.id.clone();
            let tools = match manager.ensure_client(cfg.clone()) {
                Ok(client) => {
                    let mut locked = client.lock().map_err(|_| "MCP client 锁失败".to_string())?;
                    locked.tools_list()
                }
                Err(err) => Err(err),
            };

            match tools {
                Ok(tools) => {
                    succeeded += 1;
                    out.extend(tools);
                }
                Err(err) => {
                    eprintln!(
                        "[MCP] 跳过 server `{}` 的 tools/list，继续对话流程：{}",
                        server_id, err
                    );
                    failures.push(format!("{server_id}: {err}"));
                }
            }
        }

        // 部分失败沿用跳过语义；全军覆没必须让前端可见，否则工具静默消失无从排查。
        if succeeded == 0 && !failures.is_empty() {
            return Err(format!(
                "所有已启用的 MCP server 都不可用：\n{}",
                failures.join("\n")
            ));
        }

        Ok(out)
    })
    .await
    .map_err(|e| format!("mcp_list_tools join failed: {e}"))?
}

/// 调用工具（tools/call）。server 必须已在池中（由 mcp_list_tools 或
/// mcp_test_server(persist=true) 建立），否则如实报错。
#[tauri::command]
pub async fn mcp_call_tool(
    server_id: String,
    tool_name: String,
    arguments: Value,
) -> Result<McpCallToolResponse, String> {
    let manager = runtime();
    tauri::async_runtime::spawn_blocking(move || {
        let id = server_id.trim().to_string();
        if id.is_empty() {
            return Err("server_id cannot be empty".to_string());
        }

        let map = manager
            .clients
            .lock()
            .map_err(|_| "Failed to lock MCP state".to_string())?;
        let client = map.get(&id).cloned().ok_or_else(|| {
            format!(
                "Unknown MCP server: {id} (it may have been reconfigured or stopped; \
                 the tool list refreshes on the next conversation turn)"
            )
        })?;
        drop(map);

        let mut locked = client
            .lock()
            .map_err(|_| "Failed to lock MCP client".to_string())?;
        locked.tools_call(tool_name.trim(), arguments)
    })
    .await
    .map_err(|e| format!("mcp_call_tool join failed: {e}"))?
}

/// 连接测试（LA 语义）：phase 分类 config | spawn | initialize | tools_list；
/// `persist`（缺省 true）= 连接进池复用；`includeSchema` 控制工具入参 schema
/// 是否随诊断返回。
#[tauri::command]
pub async fn mcp_test_server(
    server: McpServerConfig,
    include_schema: Option<bool>,
    persist: Option<bool>,
) -> Result<McpRuntimeTestResponse, String> {
    let manager = runtime();
    tauri::async_runtime::spawn_blocking(move || {
        manager.test_client(
            server,
            include_schema.unwrap_or(false),
            false,
            persist.unwrap_or(true),
        )
    })
    .await
    .map_err(|e| format!("mcp_test_server join failed: {e}"))?
}

/// 重启并测试：先逐出池内旧连接再走 test 流程。
#[tauri::command]
pub async fn mcp_restart_server(
    server: McpServerConfig,
    include_schema: Option<bool>,
    persist: Option<bool>,
) -> Result<McpRuntimeTestResponse, String> {
    let manager = runtime();
    tauri::async_runtime::spawn_blocking(move || {
        manager.test_client(
            server,
            include_schema.unwrap_or(false),
            true,
            persist.unwrap_or(true),
        )
    })
    .await
    .map_err(|e| format!("mcp_restart_server join failed: {e}"))?
}

/// 查询某服务器运行时状态（不启动新连接；不在池中返回 running=false）。
#[tauri::command]
pub async fn mcp_runtime_status(server_id: String) -> Result<McpRuntimeStatus, String> {
    let manager = runtime();
    tauri::async_runtime::spawn_blocking(move || manager.runtime_status(&server_id))
        .await
        .map_err(|e| format!("mcp_runtime_status join failed: {e}"))?
}

/// 显式停止某服务器连接（逐出池 + shutdown 子进程）。
#[tauri::command]
pub async fn mcp_stop_server(server_id: String) -> Result<McpStopServerResponse, String> {
    let manager = runtime();
    tauri::async_runtime::spawn_blocking(move || {
        let id = server_id.trim().to_string();
        let stopped = manager.stop_client(&id)?;
        Ok(McpStopServerResponse {
            server_id: id,
            stopped,
        })
    })
    .await
    .map_err(|e| format!("mcp_stop_server join failed: {e}"))?
}

// ---------------------------------------------------------------------------
// 测试（移植 LA 的纯逻辑单测 + 本项目新增的兼容/URL 用例）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_config(id: &str, command: &str) -> McpServerConfig {
        McpServerConfig {
            id: id.to_string(),
            description: None,
            docs_url: None,
            enabled: true,
            transport: Some("stdio".to_string()),
            command: command.to_string(),
            args: Vec::new(),
            env: None,
            cwd: None,
            url: None,
            headers: None,
            timeout_ms: Some(1_000),
            message_url: None,
        }
    }

    fn url_config(id: &str, transport: &str, url: Option<&str>) -> McpServerConfig {
        McpServerConfig {
            id: id.to_string(),
            description: None,
            docs_url: None,
            enabled: true,
            transport: Some(transport.to_string()),
            command: String::new(),
            args: Vec::new(),
            env: None,
            cwd: None,
            url: url.map(|value| value.to_string()),
            headers: None,
            timeout_ms: Some(1_000),
            message_url: None,
        }
    }

    #[test]
    fn mcp_content_serializes_camel_case() {
        let image = McpContent::Image {
            data: "aW1n".to_string(),
            mime_type: "image/png".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&image).expect("serialize image block"),
            serde_json::json!({ "type": "image", "data": "aW1n", "mimeType": "image/png" }),
        );

        let text = McpContent::Text {
            text: "hi".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&text).expect("serialize text block"),
            serde_json::json!({ "type": "text", "text": "hi" }),
        );
    }

    #[test]
    fn legacy_reinagent_json_deserializes() {
        // 旧版 mcp_servers.json：含 name、env/headers 为普通对象、
        // 缺 description/docsUrl/cwd/messageUrl——必须原样读入不迁移。
        let legacy: McpServerConfig = serde_json::from_value(json!({
            "id": "srv",
            "name": "旧版字段",
            "enabled": true,
            "transport": "http",
            "command": "",
            "args": [],
            "env": { "KEY": "value" },
            "url": "https://mcp.example.com/mcp",
            "headers": { "X-Test": "1" },
            "timeoutMs": 30_000
        }))
        .expect("legacy config");
        assert_eq!(legacy.transport().trim(), "http");
        assert_eq!(legacy.timeout(), Duration::from_millis(30_000));
        assert_eq!(legacy.url_trimmed(), Some("https://mcp.example.com/mcp"));
        assert_eq!(legacy.cwd, None);

        // 旧版可省略 timeoutMs（serde default）→ 缺省 60s。
        let no_timeout: McpServerConfig =
            serde_json::from_value(json!({ "id": "a", "enabled": true }))
                .expect("minimal config");
        assert_eq!(no_timeout.timeout(), Duration::from_millis(DEFAULT_TIMEOUT_MS));
        assert_eq!(no_timeout.transport(), "stdio");
    }

    #[test]
    fn join_url_resolves_absolute_root_and_relative() {
        let base = "https://mcp.example.com/api/sse";
        assert_eq!(
            join_url(base, "https://other.example.com/message").as_deref(),
            Some("https://other.example.com/message")
        );
        assert_eq!(
            join_url(base, "/message?session=1").as_deref(),
            Some("https://mcp.example.com/message?session=1")
        );
        assert_eq!(
            join_url(base, "message").as_deref(),
            Some("https://mcp.example.com/api/message")
        );
        assert_eq!(
            join_url("https://mcp.example.com", "message").as_deref(),
            Some("https://mcp.example.com/message")
        );
        assert_eq!(join_url(base, "  "), None);
    }

    #[test]
    fn url_path_extracts_path_for_sse_guess() {
        assert_eq!(url_path("http://host:3000/sse"), "/sse");
        assert_eq!(url_path("http://host:3000/api/sse"), "/api/sse");
        assert_eq!(url_path("http://host:3000"), "/");
        assert_eq!(url_path("http://host:3000/sse?x=1"), "/sse");
    }

    #[test]
    fn runtime_status_reports_missing_server_without_starting() {
        let manager = McpRuntimeManager::default();
        let status = manager
            .runtime_status("missing")
            .expect("runtime status should succeed");
        assert_eq!(status.server_id, "missing");
        assert!(!status.running);
        assert!(!status.initialized);
    }

    #[test]
    fn stop_client_reports_whether_server_was_running() {
        let manager = McpRuntimeManager::default();
        assert!(!manager.stop_client("missing").expect("stop missing"));
    }

    #[test]
    fn test_client_rejects_invalid_stdio_config_as_config_phase() {
        let manager = McpRuntimeManager::default();
        let result = manager
            .test_client(stdio_config("bad", ""), false, false, true)
            .expect("test client response");
        assert!(!result.ok);
        assert_eq!(result.phase, "config");
        assert_eq!(result.tools_count, 0);
        assert!(result.error.unwrap().contains("command"));
    }

    #[test]
    fn test_client_rejects_missing_http_and_sse_url_as_config_phase() {
        let manager = McpRuntimeManager::default();
        for transport in ["http", "sse"] {
            let result = manager
                .test_client(url_config(transport, transport, None), false, false, true)
                .expect("test client response");
            assert!(!result.ok);
            assert_eq!(result.phase, "config");
            assert_eq!(result.tools_count, 0);
            assert!(result.error.unwrap().contains("url"));
        }
    }

    #[test]
    fn stderr_tail_is_truncated_to_recent_lines() {
        let tail = Arc::new(Mutex::new(Vec::new()));
        for index in 0..(STDERR_TAIL_MAX_LINES + 5) {
            append_stderr_tail(&tail, format!("line-{index}"));
        }
        let locked = tail.lock().expect("tail lock");
        assert_eq!(locked.len(), STDERR_TAIL_MAX_LINES);
        assert_eq!(locked.first().map(String::as_str), Some("line-5"));
        assert_eq!(
            locked.last(),
            Some(&format!("line-{}", STDERR_TAIL_MAX_LINES + 4))
        );
    }

    // http transport spawn 只解析 URL 与构建 client，不发起真实连接，
    // 因此可离线构造池内条目。
    fn offline_http_config(id: &str) -> McpServerConfig {
        url_config(id, "http", Some("http://127.0.0.1:9/mcp"))
    }

    #[test]
    fn ensure_client_reuses_same_config_and_replaces_changed_config() {
        let manager = McpRuntimeManager::default();
        let first = manager
            .ensure_client(offline_http_config("srv"))
            .expect("first ensure");
        let second = manager
            .ensure_client(offline_http_config("srv"))
            .expect("second ensure");
        assert!(Arc::ptr_eq(&first, &second));

        let changed = manager
            .ensure_client(url_config("srv", "http", Some("http://127.0.0.1:9/mcp2")))
            .expect("changed ensure");
        assert!(!Arc::ptr_eq(&first, &changed));
    }

    #[test]
    fn ensure_client_evicts_stale_client_when_respawn_fails() {
        let manager = McpRuntimeManager::default();
        manager
            .ensure_client(offline_http_config("srv"))
            .expect("initial ensure");

        // 换成必然 spawn 失败的配置（URL 校验不过）：
        // 旧 client 必须被逐出，否则 mcp_call_tool 直读 map 会继续走失效通道。
        // （不用 expect_err：Ok 侧 Arc<Mutex<McpClient>> 无 Debug——ureq::Agent 不实现。）
        assert!(
            manager
                .ensure_client(url_config("srv", "http", Some("::not-a-url::")))
                .is_err(),
            "respawn must fail"
        );
        assert!(
            !manager
                .clients
                .lock()
                .expect("clients lock")
                .contains_key("srv"),
            "stale client must be evicted after failed respawn"
        );
    }

    #[test]
    fn busy_client_does_not_block_other_servers() {
        use std::sync::Barrier;
        use std::time::Duration;

        let manager = Arc::new(McpRuntimeManager::default());
        let client_a = manager
            .ensure_client(offline_http_config("server-a"))
            .expect("seed server-a");

        let barrier = Arc::new(Barrier::new(3));
        // Holder 模拟 server A 上的长 tools/call。
        let holder = {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let _guard = client_a.lock().expect("hold server-a");
                barrier.wait();
                std::thread::sleep(Duration::from_millis(800));
            })
        };
        // Contender 在 ensure_client 里阻塞在 server A 的 client 锁上。
        // 旧实现持 map 锁穿过该锁，会让其它 server 的命令全部排队。
        let contender = {
            let manager = manager.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                manager.ensure_client(offline_http_config("server-a"))
            })
        };

        barrier.wait();
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        manager
            .ensure_client(offline_http_config("server-b"))
            .expect("ensure server-b");
        let status = manager.runtime_status("server-b").expect("status server-b");
        assert_eq!(status.server_id, "server-b");
        assert!(manager.stop_client("server-b").expect("stop server-b"));
        assert!(
            started.elapsed() < Duration::from_millis(400),
            "server-b commands stalled behind server-a's busy client"
        );

        contender
            .join()
            .expect("join contender")
            .expect("contender ensure eventually succeeds");
        holder.join().expect("join holder");
    }

    #[test]
    fn detects_windows_batch_programs_by_extension() {
        assert!(is_windows_batch_program(Path::new(
            r"C:\Program Files\nodejs\npx.cmd"
        )));
        assert!(is_windows_batch_program(Path::new(r"C:\tools\run.BAT")));
        assert!(!is_windows_batch_program(Path::new(
            r"C:\Program Files\nodejs\node.exe"
        )));
        assert!(!is_windows_batch_program(Path::new("npx")));
    }

    #[test]
    fn windows_cmd_quote_arg_doubles_embedded_quotes() {
        // cmd.exe 不认 `\"` 转义，翻倍才能保持引号配对。
        assert_eq!(windows_cmd_quote_arg("-y"), r#""-y""#);
        assert_eq!(windows_cmd_quote_arg(r#"a"b"#), r#""a""b""#);
        assert_eq!(windows_cmd_quote_arg("with space"), r#""with space""#);
    }

    #[test]
    fn windows_cmd_quote_arg_doubles_backslashes_before_quotes() {
        // 内嵌引号前的反斜杠须补齐至 2n，重解析后还原为 n 个反斜杠 + 字面引号。
        assert_eq!(windows_cmd_quote_arg(r#"a\"b"#), r#""a\\""b""#);
        // 尾部反斜杠若不翻倍会把闭合引号转义掉，与后一个参数粘连。
        assert_eq!(windows_cmd_quote_arg(r"C:\data\"), r#""C:\data\\""#);
        // 非贴引号的反斜杠保持原样（路径分隔符不受影响）。
        assert_eq!(windows_cmd_quote_arg(r"C:\a\b"), r#""C:\a\b""#);
        assert_eq!(windows_cmd_quote_arg(""), r#""""#);
    }

    #[test]
    fn windows_cmd_quote_arg_neutralizes_percent_expansion() {
        // `%%cd:~,` no-op 打断 %VAR% 配对，cmd 展开后子进程仍收到原文。
        assert_eq!(windows_cmd_quote_arg("%PATH%"), r#""%%cd:~,%PATH%%cd:~,%""#);
        assert_eq!(windows_cmd_quote_arg("100%"), r#""100%%cd:~,%""#);
        assert_eq!(windows_cmd_quote_arg("a\rb"), "\"a%%cd:~,\rb\"");
    }

    #[test]
    fn windows_cmd_c_argument_wraps_whole_line_for_slash_s() {
        // `/S` 语义：cmd 剥掉首尾引号后必须还原出可执行的完整命令行。
        let program = Path::new(r"C:\Program Files\nodejs\npx.cmd");
        let args = vec!["-y".to_string(), "@playwright/mcp".to_string()];
        assert_eq!(
            windows_cmd_c_argument(program, &args),
            r#"""C:\Program Files\nodejs\npx.cmd" "-y" "@playwright/mcp"""#
        );
    }

    #[test]
    fn windows_cmd_c_argument_without_args_still_quotes_program() {
        let program = Path::new(r"C:\tools\npx.cmd");
        assert_eq!(
            windows_cmd_c_argument(program, &[]),
            r#"""C:\tools\npx.cmd"""#
        );
    }

    #[test]
    fn windows_cmd_c_argument_survives_trailing_backslash_arg() {
        // filesystem 类 MCP server 常见传法：目录参数带尾部反斜杠。
        let program = Path::new(r"C:\Program Files\nodejs\npx.cmd");
        let args = vec![
            "-y".to_string(),
            "@modelcontextprotocol/server-filesystem".to_string(),
            r"C:\Users\me\docs\".to_string(),
        ];
        assert_eq!(
            windows_cmd_c_argument(program, &args),
            r#"""C:\Program Files\nodejs\npx.cmd" "-y" "@modelcontextprotocol/server-filesystem" "C:\Users\me\docs\\"""#
        );
    }
}
