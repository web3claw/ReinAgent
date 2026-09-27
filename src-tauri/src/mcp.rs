//! MCP（Model Context Protocol）集成——对齐 LiveAgent `commands/integration/mcp.rs`
//! 的一期子集：
//! - 服务器配置存 `~/.ReinAgent/mcp_servers.json`（serde camelCase，与前端类型一致）；
//! - 传输：stdio（spawn 子进程 + 行协议 JSON-RPC 2.0，进程组 kill）与
//!   streamable-http（POST endpoint + `Mcp-Session-Id` 会话头）双实现；
//! - 握手：`initialize` → `notifications/initialized` → `tools/list` / `tools/call`；
//! - 命令：`mcp_list_servers / mcp_save_servers / mcp_list_tools / mcp_call_tool /
//!   mcp_test_server / mcp_stop_server`；
//! - 进程树 kill 复用 LiveAgent 的 best-effort 语义（std only，无 nix 依赖）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// 配置（~/.ReinAgent/mcp_servers.json）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// stdio | http
    #[serde(default = "default_transport")]
    pub transport: String,
    /// stdio：可执行命令
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// http：endpoint URL
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// 请求超时（毫秒，缺省 30s）
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

fn default_transport() -> String {
    "stdio".into()
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
// JSON-RPC（两种传输共享的请求抽象）
// ---------------------------------------------------------------------------

trait Transport: Send {
    fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String>;
    fn notify(&mut self, method: &str) -> Result<(), String>;
    fn shutdown(&mut self);
}

fn parse_jsonrpc_result(method: &str, id: u64, msg: &Value) -> Result<Value, String> {
    if let Some(err) = msg.get("error") {
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(format!("{method} 失败: {message}"));
    }
    if msg.get("id").and_then(Value::as_u64) != Some(id) {
        return Err(format!("{method}: response id mismatch"));
    }
    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

// ---- stdio 传输 ----

struct StdioTransport {
    child: Child,
    stdin: std::process::ChildStdin,
    stdout_rx: mpsc::Receiver<String>,
    stderr_tail: Arc<Mutex<Vec<String>>>,
}

impl StdioTransport {
    fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        let cmd = config.command.trim();
        if cmd.is_empty() {
            return Err("stdio 传输需要 command".into());
        }
        let mut command = Command::new(cmd);
        command.args(&config.args);
        command.envs(&config.env);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|e| format!("启动 MCP server 失败: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法获取 stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法获取 stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法获取 stderr".to_string())?;

        let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        {
            let tail = stderr_tail.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    let mut guard = tail.lock().unwrap_or_else(|e| e.into_inner());
                    guard.push(line);
                    if guard.len() > 20 {
                        guard.remove(0);
                    }
                }
            });
        }

        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });

        Ok(Self { child, stdin, stdout_rx: rx, stderr_tail })
    }

    fn stderr_summary(&self) -> String {
        let guard = self.stderr_tail.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_empty() {
            String::new()
        } else {
            format!("  stderr: {}", guard.join(" | "))
        }
    }
}

impl Transport for StdioTransport {
    fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(self.stdin, "{req}")
            .map_err(|e| format!("写入 MCP stdin 失败: {e}{}", self.stderr_summary()))?;
        self.stdin
            .flush()
            .map_err(|e| format!("flush stdin 失败: {e}"))?;

        // 逐行读直到匹配 id（忽略通知/其他 id）；一期固定 30s 超时
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "MCP 请求超时: {method} (id={id}){}",
                    self.stderr_summary()
                ));
            }
            let line = self
                .stdout_rx
                .recv_timeout(remaining)
                .map_err(|e| format!("读取 MCP stdout 失败或超时: {e}{}", self.stderr_summary()))?;
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if msg.get("id").and_then(Value::as_u64) == Some(id) {
                return parse_jsonrpc_result(method, id, &msg)
                    .map_err(|e| format!("{e}{}", self.stderr_summary()));
            }
        }
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        let note = json!({"jsonrpc": "2.0", "method": method});
        writeln!(self.stdin, "{note}").map_err(|e| format!("写入通知失败: {e}"))?;
        self.stdin.flush().map_err(|e| format!("flush 失败: {e}"))
    }

    fn shutdown(&mut self) {
        kill_child_process_tree_best_effort(&mut self.child);
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// best-effort 进程树终止（对齐 LiveAgent 同名函数；std only：先 kill 直接子进程，
/// Unix 下再对进程组补刀）。
fn kill_child_process_tree_best_effort(child: &mut Child) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        let pid = child.id() as i32;
        // 向进程组发 SIGTERM（spawn 时未 setsid，则组 id = pid 的父组，尽力而为）
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        std::thread::sleep(Duration::from_millis(200));
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = child.kill();
        let _ = child.wait();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

// ---- HTTP（streamable）传输 ----

struct HttpTransport {
    endpoint: String,
    headers: BTreeMap<String, String>,
    session_id: Option<String>,
    client: ureq::Agent,
    timeout: Duration,
}

impl HttpTransport {
    fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        if config.url.trim().is_empty() {
            return Err("http 传输需要 url".into());
        }
        let timeout = Duration::from_millis(config.timeout_ms.unwrap_or(30_000));
        let client = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .build()
            .into();
        Ok(Self {
            endpoint: config.url.trim().to_string(),
            headers: config.headers.clone(),
            session_id: None,
            client,
            timeout,
        })
    }

    fn post(&mut self, body: &Value) -> Result<String, String> {
        let mut req = self
            .client
            .post(&self.endpoint)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream");
        if let Some(sid) = &self.session_id {
            req = req.header("Mcp-Session-Id", sid);
        }
        for (k, v) in &self.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let mut resp = req
            .send_json(body.clone())
            .map_err(|e| format!("MCP HTTP 请求失败: {e}"))?;
        // 会话头：initialize 响应携带后续请求所需的 Mcp-Session-Id
        if let Some(sid) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            self.session_id = Some(sid.to_string());
        }
        resp.body_mut()
            .read_to_string()
            .map_err(|e| format!("读取响应失败: {e}"))
    }
}

impl Transport for HttpTransport {
    fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let text = self.post(&req)?;
        // 响应可能是 JSON 或 SSE（data: 行）；取最后一个 data: 载荷
        let json_text = if text.trim_start().starts_with("event:") || text.contains("\ndata:") {
            text.lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .last()
                .unwrap_or(&text)
                .trim()
                .to_string()
        } else {
            text
        };
        let msg: Value =
            serde_json::from_str(&json_text).map_err(|e| format!("响应不是合法 JSON: {e}"))?;
        parse_jsonrpc_result(method, id, &msg)
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        let note = json!({"jsonrpc": "2.0", "method": method});
        self.post(&note).map_err(|e| format!("发送通知失败: {e}"))?;
        Ok(())
    }

    fn shutdown(&mut self) {}
}

// ---------------------------------------------------------------------------
// 连接池（同一 server 复用连接，TTL 5 分钟空闲回收）
// ---------------------------------------------------------------------------

struct PooledConnection {
    transport: Box<dyn Transport>,
    last_used: Instant,
}

static POOL: std::sync::OnceLock<Mutex<HashMap<String, PooledConnection>>> =
    std::sync::OnceLock::new();

fn pool() -> &'static Mutex<HashMap<String, PooledConnection>> {
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取（或建立）一个已握手的传输连接。连接池互斥期间执行完整 RPC。
fn with_transport<T>(
    config: &McpServerConfig,
    f: impl FnOnce(&mut dyn Transport) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = pool().lock().unwrap_or_else(|e| e.into_inner());
    let entry = guard.remove(&config.id);
    let mut conn = match entry {
        Some(c) if c.last_used.elapsed() < Duration::from_secs(300) => Some(c),
        mut other => {
            if let Some(mut c) = other.take() {
                c.transport.shutdown();
            }
            None
        }
    };
    if conn.is_none() {
        let mut transport: Box<dyn Transport> = match config.transport.as_str() {
            "http" => Box::new(HttpTransport::spawn(config)?),
            _ => Box::new(StdioTransport::spawn(config)?),
        };
        // initialize 握手（对齐 LiveAgent：protocolVersion 2024-11-05 + capabilities）
        let init = transport.request(
            1,
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "ReinAgent", "version": env!("CARGO_PKG_VERSION")}
            }),
        )?;
        let _ = init;
        transport.notify("notifications/initialized")?;
        conn = Some(PooledConnection { transport, last_used: Instant::now() });
    }
    let mut conn = conn.expect("just created");
    let result = f(conn.transport.as_mut());
    conn.last_used = Instant::now();
    guard.insert(config.id.clone(), conn);
    result
}

// ---------------------------------------------------------------------------
// IPC 命令
// ---------------------------------------------------------------------------

/// 工具描述（tools/list 的精简投影）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListToolsResult {
    pub server_id: String,
    pub tools: Vec<McpToolInfo>,
}

/// 保存全部服务器配置（前端整表编辑后一次性写盘）。
#[tauri::command]
pub async fn mcp_save_servers(servers: Vec<McpServerConfig>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_servers(&servers))
        .await
        .map_err(|e| e.to_string())?
}

/// 列出全部服务器配置。
#[tauri::command]
pub async fn mcp_list_servers() -> Result<Vec<McpServerConfig>, String> {
    Ok(load_servers())
}

/// 枚举某服务器的工具列表（握手 + tools/list）。
#[tauri::command]
pub async fn mcp_list_tools(server: McpServerConfig) -> Result<McpListToolsResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let server_id = server.id.clone();
        with_transport(&server, |transport| {
            let result = transport.request(2, "tools/list", json!({}))?;
            let tools = result
                .get("tools")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|t| McpToolInfo {
                    name: t
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    description: t
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    input_schema: t.get("inputSchema").cloned().unwrap_or(Value::Null),
                })
                .collect();
            Ok(McpListToolsResult { server_id, tools })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 调用工具（tools/call；isError 与错误文本由前端透传给模型侧处理）。
#[tauri::command]
pub async fn mcp_call_tool(
    server: McpServerConfig,
    tool_name: String,
    arguments: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_transport(&server, |transport| {
            transport.request(
                3,
                "tools/call",
                json!({"name": tool_name, "arguments": arguments}),
            )
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 连接测试：尝试握手 + tools/list，返回工具数量或错误。
#[tauri::command]
pub async fn mcp_test_server(server: McpServerConfig) -> Result<McpListToolsResult, String> {
    mcp_list_tools(server).await
}

/// 显式停止某服务器连接（池内回收 + shutdown）。
#[tauri::command]
pub async fn mcp_stop_server(server_id: String) -> Result<(), String> {
    let mut guard = pool().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut conn) = guard.remove(&server_id) {
        conn.transport.shutdown();
    }
    Ok(())
}
