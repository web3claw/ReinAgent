//! Hooks（P2-G2）：工作区 hook 执行器。
//!
//! 配置在 `<workspace>/.ReinAgent/config.json` 的 `hooks` 数组（TS 侧发现/信任评审），
//! 本模块负责**执行一条 hook**：
//! - `hook_execute`：spawn shell（win: cmd /C、unix: sh -c），stdin 写入事件 JSON，
//!   限时等待，回传 exit code + stdout/stderr。
//! - `hook_http_execute`：发送一条 HTTP 请求（ureq，走 kv 全局代理设置，同 MCP），
//!   回传状态码 + 响应体片段。
//! 输出协议解析在 TS 侧（对齐 Claude Code：stdout JSON / exit 2 = block）。

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::command;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookExecuteArgs {
    pub command: String,
    pub cwd: String,
    /// 序列化好的事件 JSON（HookInput），写入 hook 进程 stdin
    pub stdin_json: String,
    /// 超时毫秒；缺省 30s，上限 120s
    pub timeout_ms: Option<u64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookExecuteResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// true = 超时被杀
    pub timed_out: bool,
}

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

/// HTTP hook 的超时口径与 LiveAgent 对齐：默认 60s，上限 600s（shell 侧硬上限不变）。
const DEFAULT_HTTP_TIMEOUT_MS: u64 = 60_000;
const MAX_HTTP_TIMEOUT_MS: u64 = 600_000;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookHttpRequest {
    pub url: String,
    /// 缺省 POST
    pub method: Option<String>,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    /// 任意 JSON 值；GET/HEAD/OPTIONS 忽略
    pub body: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookHttpExecuteArgs {
    pub request: HookHttpRequest,
    /// 超时毫秒；缺省 60s，上限 600s
    pub timeout_ms: Option<u64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookHttpExecuteResult {
    /// HTTP 状态码；连接失败/超时为 null
    pub status: Option<u16>,
    /// true = 2xx
    pub ok: bool,
    /// 响应体前 2000 字符（诊断用）
    pub body_snippet: String,
    /// true = 超时
    pub timed_out: bool,
    /// 网络/URL 等硬错误描述（有错误时 status 为 null）
    pub error: Option<String>,
}

#[command]
pub async fn hook_http_execute(
    args: HookHttpExecuteArgs,
) -> Result<HookHttpExecuteResult, String> {
    let timeout_ms = args
        .timeout_ms
        .unwrap_or(DEFAULT_HTTP_TIMEOUT_MS)
        .clamp(1, MAX_HTTP_TIMEOUT_MS);
    tauri::async_runtime::spawn_blocking(move || run_http_request(args.request, timeout_ms))
        .await
        .map_err(|e| e.to_string())?
}

fn run_http_request(
    request: HookHttpRequest,
    timeout_ms: u64,
) -> Result<HookHttpExecuteResult, String> {
    use std::io::Read as _;

    let method = request.method.unwrap_or_else(|| "POST".to_string());
    let upper = method.to_ascii_uppercase();
    let http_method = tauri::http::Method::from_bytes(upper.as_bytes())
        .map_err(|e| format!("hook http: 无效方法 {upper}: {e}"))?;
    let has_body = matches!(upper.as_str(), "POST" | "PUT" | "PATCH" | "DELETE");

    let mut config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_millis(timeout_ms)));
    // 走 kv 全局代理设置，但按 URL 匹配 no-proxy 规则（hook 常打本机/局域网端点，
    // 不能像 MCP 那样无条件过代理——127.0.0.1 进代理必然 Peer disconnected）
    if let Ok(Some(proxy)) = crate::web_tools::resolve_proxy_for_url(&request.url) {
        config = config.proxy(Some(proxy));
    }
    let client: ureq::Agent = config.build().into();

    let mut builder = tauri::http::Request::builder()
        .method(http_method)
        .uri(&request.url);
    for (key, value) in &request.headers {
        builder = builder.header(key, value);
    }

    // URL/header 等硬错误如实回传给 UI（Fail-Fast，不静默吞）
    let body = request.body.unwrap_or(serde_json::Value::Null);
    let payload: Vec<u8> = if has_body && !body.is_null() {
        serde_json::to_vec(&body).map_err(|e| format!("hook http: 序列化 body 失败: {e}"))?
    } else {
        Vec::new()
    };
    let http_request = builder
        .body(payload)
        .map_err(|e| format!("hook http: 构造请求失败: {e}"))?;

    match client.run(http_request) {
        Ok(mut resp) => {
            let status = resp.status().as_u16();
            let mut reader = resp.body_mut().as_reader().take(2048);
            let mut raw = Vec::new();
            let _ = reader.read_to_end(&mut raw);
            Ok(HookHttpExecuteResult {
                status: Some(status),
                ok: (200..300).contains(&status),
                body_snippet: String::from_utf8_lossy(&raw).to_string(),
                timed_out: false,
                error: None,
            })
        }
        Err(e) => {
            let text = e.to_string();
            let timed_out = text.contains("timed out") || text.contains("timeout");
            Ok(HookHttpExecuteResult {
                status: None,
                ok: false,
                body_snippet: String::new(),
                timed_out,
                error: Some(text),
            })
        }
    }
}

#[command]
pub async fn hook_execute(args: HookExecuteArgs) -> Result<HookExecuteResult, String> {
    let timeout_ms = args
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);
    let cwd = args.cwd;
    tauri::async_runtime::spawn_blocking(move || {
        let cwd_path = std::path::PathBuf::from(&cwd);
        let mut child = spawn_hook_process(&args.command, &cwd_path)
            .map_err(|e| format!("hook spawn failed: {e}"))?;

        // stdin 写入事件 JSON（进程不读 stdin 时 write 可能触发 SIGPIPE/错误——容忍）
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(args.stdin_json.as_bytes());
            let _ = stdin.flush();
            // drop stdin 关闭写端，hook 才会读到 EOF
        }

        let timeout = std::time::Duration::from_millis(timeout_ms);
        match wait_with_timeout(child, timeout) {
            Ok(output) => Ok(output),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn spawn_hook_process(command: &str, cwd: &std::path::Path) -> std::io::Result<std::process::Child> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = Command::new("cmd");
        cmd.raw_arg("/C").raw_arg(command);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.current_dir(cwd);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.spawn()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("sh")
            .arg("-c")
            .arg(command)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    }
}

/// 限时等待：读 stdout/stderr（子线程）+ wait 轮询；超时 kill。
fn wait_with_timeout(
    mut child: std::process::Child,
    timeout: std::time::Duration,
) -> Result<HookExecuteResult, String> {
    use std::io::Read;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let stdout_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_string(&mut buf);
        }
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_string(&mut buf);
        }
        buf
    });

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_handle
                    .join()
                    .map_err(|_| "join stdout reader failed".to_string())?;
                let stderr = stderr_handle
                    .join()
                    .map_err(|_| "join stderr reader failed".to_string())?;
                return Ok(HookExecuteResult {
                    exit_code: status.code(),
                    stdout,
                    stderr,
                    timed_out: false,
                });
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let stdout = stdout_handle
                        .join()
                        .map_err(|_| "join stdout reader failed".to_string())?;
                    let stderr = stderr_handle
                        .join()
                        .map_err(|_| "join stderr reader failed".to_string())?;
                    return Ok(HookExecuteResult {
                        exit_code: None,
                        stdout,
                        stderr,
                        timed_out: true,
                    });
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("hook wait failed: {e}")),
        }
    }
}
