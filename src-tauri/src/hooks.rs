//! Hooks（P2-G2）：工作区 hook 执行器。
//!
//! 配置在 `<workspace>/.ReinAgent/config.json` 的 `hooks` 数组（TS 侧发现/信任评审），
//! 本模块只负责**执行一条 hook 命令**：spawn shell（win: cmd /C、unix: sh -c），
//! stdin 写入事件 JSON，限时等待，回传 exit code + stdout/stderr。
//! 输出协议解析在 TS 侧（对齐 Claude Code：stdout JSON / exit 2 = block）。

use std::io::Write;
use std::process::{Command, Stdio};
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
