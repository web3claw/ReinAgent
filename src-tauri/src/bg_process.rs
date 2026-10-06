//! bg_process.rs —— 后台驻留进程管理（对齐 ZCode handlers/bash-background-* 与
//! LiveAgent managed-process 的最小可用版）。
//!
//! 三命令：
//! - `bg_spawn(cwd, command)`：启动驻留进程（dev server / watch / 长构建），立即返回 taskId；
//! - `bg_output(taskId, offset?)`：返回运行状态与**增量输出**（调用方持 offset 续读）；
//! - `bg_stop(taskId)`：终止进程树（Windows `taskkill /T /F`；Unix 进程组 kill）。
//!
//! 设计：
//! - 注册表：进程内 `OnceLock<Mutex<HashMap<taskId, BgProcess>>>`（不落库——后台任务
//!   是会话级概念，应用退出进程树随进程消失，任务列表本就该为空）；
//! - 输出：stdout/stderr 各一条读线程，写入共享 `Arc<Mutex<Vec<u8>>>` 缓冲
//!   （上限 256KB，超限丢头部保尾部并累计 dropped），`try_wait` 轮询写 exit 状态；
//! - 安全：与 fs_execute 同款条件编译（`#[cfg]` 属性，非 `if cfg!()`）；Windows
//!   raw_arg 透传 + CREATE_NO_WINDOW。

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const OUTPUT_CAP_BYTES: usize = 256 * 1024;

/// 停止流程的等待预算：TERM 后 2s 仍未终止 → 升级 KILL，再等 0.5s。
const STOP_TERM_GRACE_MS: u64 = 2000;
const STOP_KILL_GRACE_MS: u64 = 500;

/// taskId 单调序号：仅用毫秒会在一轮并发 spawn（或并行测试）里撞 id，
/// 后注册者覆盖前者，导致 `bg_output` 报「任务不存在」、stop 误删他人注册表项。
static TASK_SEQ: AtomicUsize = AtomicUsize::new(0);

pub struct BgProcess {
    child: Child,
    /// stdout+stderr 合并输出缓冲（读线程持续追加，cap 时丢头部保尾部）
    output: Arc<Mutex<Vec<u8>>>,
    dropped: Arc<AtomicUsize>,
    /// 读线程发现进程退出后置 true（try_wait 兜底）
    exited: Arc<AtomicBool>,
    started_at_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgSpawnResult {
    pub task_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgOutput {
    pub task_id: String,
    /// running | exited
    pub status: String,
    pub exit_code: Option<i32>,
    /// 从 offset 起的增量输出
    pub new_output: String,
    /// 累计输出总字节数（调用方推进 offset 用）
    pub total_bytes: usize,
    /// 超过 256KB 上限后丢弃的头部字节数
    pub dropped_bytes: usize,
    pub started_at_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgStopResult {
    pub task_id: String,
    /// 仅在**确认进程组已终止**时为 true；任务不存在或未能终止 → false。
    pub stopped: bool,
    /// 是否因 TERM 未奏效而升级到 KILL。
    pub forced: bool,
    /// 未能终止时的真实原因（No-Fallback；成功收敛时为 None）。
    pub error: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn registry() -> &'static Mutex<HashMap<String, BgProcess>> {
    static REGISTRY: std::sync::OnceLock<Mutex<HashMap<String, BgProcess>>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 启动驻留后台进程。立即返回 taskId；输出经 bg_output 增量读取。
#[tauri::command]
pub async fn bg_spawn(command: String, cwd: Option<String>) -> Result<BgSpawnResult, String> {
    tauri::async_runtime::spawn_blocking(move || bg_spawn_sync(command, cwd))
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn bg_spawn_sync(command: String, cwd: Option<String>) -> Result<BgSpawnResult, String> {
        let exec_dir = match cwd {
            Some(ref dir) if !dir.trim().is_empty() => {
                let dir = std::path::PathBuf::from(dir.trim());
                if !dir.is_dir() {
                    return Err(format!("bg_spawn: cwd 不是目录: {}", dir.display()));
                }
                dir
            }
            _ => {
                let home = std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .unwrap_or_default();
                let dir = std::path::Path::new(&home)
                    .join(".ReinAgent")
                    .join("DefaultProject");
                let _ = std::fs::create_dir_all(&dir);
                dir
            }
        };

        let mut child = spawn_shell(&command, &exec_dir)
            .map_err(|e| format!("bg_spawn: 启动失败: {e}"))?;

        // 共享输出缓冲 + 读线程：stdout/stderr 各一线程写入（cap 时丢头部保尾部），
        // 进程退出后两线程自然结束并置 exited 标志。
        let output: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let dropped: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
        let exited: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
        {
            let mut stdout = child.stdout.take().expect("stdout piped");
            let mut stderr = child.stderr.take().expect("stderr piped");
            let buf_out = Arc::clone(&output);
            let buf_err = Arc::clone(&output);
            let drop_out = Arc::clone(&dropped);
            let drop_err = Arc::clone(&dropped);
            std::thread::spawn(move || pump_stream(&mut stdout, &buf_out, &drop_out));
            std::thread::spawn(move || pump_stream(&mut stderr, &buf_err, &drop_err));
            let exit_flag = Arc::clone(&exited);
            std::thread::spawn(move || {
                // 读线程结束后兜底置位（try_wait 在 bg_output 中另有收割）
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    if exit_flag.load(Ordering::Relaxed) {
                        break;
                    }
                }
            });
        }

        let task_id = format!("bg-{}-{}", now_ms(), TASK_SEQ.fetch_add(1, Ordering::Relaxed));
        let process = BgProcess {
            child,
            output,
            dropped,
            exited,
            started_at_ms: now_ms(),
        };
        registry()
            .lock()
            .map_err(|e| e.to_string())?
            .insert(task_id.clone(), process);

        Ok(BgSpawnResult { task_id })
}

/// 单流读取泵：持续 append 到共享输出缓冲（cap 时丢头部保尾部并累计 dropped）。
fn pump_stream<R: Read>(reader: &mut R, buf: &Mutex<Vec<u8>>, dropped: &AtomicUsize) {
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut guard = match buf.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                guard.extend_from_slice(&chunk[..n]);
                if guard.len() > OUTPUT_CAP_BYTES {
                    let excess = guard.len() - OUTPUT_CAP_BYTES;
                    guard.drain(..excess);
                    dropped.fetch_add(excess, Ordering::Relaxed);
                }
            }
        }
    }
}

fn spawn_shell(command: &str, exec_dir: &std::path::Path) -> std::io::Result<Child> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = Command::new("cmd");
        cmd.raw_arg("/C").raw_arg(command);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.current_dir(exec_dir);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.spawn()
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(command)
            .current_dir(exec_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // 独立进程组（pgid == 子进程 pid）：bg_stop 的 `kill -<pid>` 才能命中整棵进程树。
        // 与 mcp.rs::configure_child_process_group 同款；缺这一步时信号发给一个不存在的
        // 进程组（ESRCH），停止按钮表现为完全无反应。
        cmd.process_group(0);
        cmd.spawn()
    }
}

/// 读取后台进程状态与增量输出。
#[tauri::command]
pub async fn bg_output(task_id: String, offset: Option<usize>) -> Result<BgOutput, String> {
    tauri::async_runtime::spawn_blocking(move || bg_output_sync(task_id, offset))
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn bg_output_sync(task_id: String, offset: Option<usize>) -> Result<BgOutput, String> {
        let mut registry = registry().lock().map_err(|e| e.to_string())?;
        let process = registry
            .get_mut(&task_id)
            .ok_or_else(|| format!("bg_output: 任务不存在: {task_id}"))?;

        // 先 try_wait 收割退出状态（读线程的 exited 标志可能早于 try_wait）
        let _ = process.child.try_wait();
        let status = if process.exited.load(Ordering::Relaxed) || is_child_exited(&mut process.child) {
            "exited"
        } else {
            "running"
        };
        let exit_code = process.child.try_wait().ok().flatten().and_then(|s| s.code());

        let buf = process.output.lock().map_err(|e| e.to_string())?;
        let total = buf.len();
        let offset = offset.unwrap_or(0).min(total);
        // 控制台代码页兜底解码（zh-CN 控制台程序往管道写 GBK；UTF-8 严格校验优先）
        let new_output = crate::console_decode::decode_console_bytes(&buf[offset..]);
        Ok(BgOutput {
            task_id,
            status: status.to_string(),
            exit_code,
            new_output,
            total_bytes: total,
            dropped_bytes: process.dropped.load(Ordering::Relaxed),
            started_at_ms: process.started_at_ms,
        })
}

fn is_child_exited(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(Some(_)))
}

/// 向整个进程组发信号（force=false → TERM，true → KILL）；失败返回真实原因，不静默吞掉。
#[cfg(not(target_os = "windows"))]
fn signal_process_group(pid: u32, force: bool) -> Result<(), String> {
    let signal = if force { "-KILL" } else { "-TERM" };
    let output = Command::new("kill")
        // `--` 必需：否则 `-<pid>` 会被 coreutils kill 当作选项解析，信号发不出去。
        .args([signal, "--", &format!("-{pid}")])
        .output()
        .map_err(|e| format!("kill {signal} -{pid} 启动失败: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "kill {signal} -{pid} 失败: {}",
            crate::console_decode::decode_console_bytes(output.stderr.trim_ascii()).trim().to_string()
        ))
    }
}

#[cfg(target_os = "windows")]
fn signal_process_group(pid: u32, force: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut args = vec!["/PID".to_string(), pid.to_string(), "/T".to_string()];
    if force {
        args.push("/F".to_string());
    }
    let output = Command::new("taskkill")
        .args(&args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("taskkill 启动失败: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "taskkill 失败: {}",
            crate::console_decode::decode_console_bytes(output.stderr.trim_ascii()).trim().to_string()
        ))
    }
}

/// 进程组是否仍有存活成员。
#[cfg(not(target_os = "windows"))]
pub(crate) fn process_group_alive(pid: u32) -> bool {
    // `kill -0 -- -<pid>`：组存在且可发信号 → 退出码 0；不存在 → ESRCH 非 0。
    // `--` 必需，否则 `-<pid>` 被当作选项解析、返回值不可信（实测会反着报）。
    // 用 output() 而非 status()：组不存在时的 ESRCH 是预期结果，不该把 stderr 打到应用输出。
    Command::new("kill")
        .args(["-0", "--", &format!("-{pid}")])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
pub(crate) fn process_group_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    match Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()),
        Err(_) => false,
    }
}

/// 短临界区收割子进程（try_wait 会回收僵尸）——**不持锁等待**。
///
/// 必须边探边收：僵尸 leader 会让 `kill -0 -- -<pgid>` 一直为真，
/// 不收割就会误判"进程组仍在"，把本该立即完成的停止拖到超时。
fn reap_child(task_id: &str) {
    if let Ok(mut registry) = registry().lock() {
        if let Some(process) = registry.get_mut(task_id) {
            let _ = process.child.try_wait();
        }
    }
}

/// 有界轮询等待整个进程组消失；超时返回 false（绝不无限阻塞）。
fn wait_process_group_gone(task_id: &str, pid: u32, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        reap_child(task_id);
        if !process_group_alive(pid) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// 测试用：取某后台任务的 pid。
#[cfg(test)]
pub(crate) fn bg_task_pid(task_id: &str) -> Option<u32> {
    registry()
        .lock()
        .ok()?
        .get(task_id)
        .map(|process| process.child.id())
}

/// 停止后台进程（进程树）。
///
/// 语义：任务不存在 → `stopped=false`（幂等）；仅在**确认进程组已终止**时返回
/// `stopped=true`，未能终止则如实返回 `stopped=false` + `error`（No-Fallback）。
/// 等待在 registry 锁**之外**进行，最坏 ~2.5s 返回——绝不阻塞等待子进程自然退出。
#[tauri::command]
pub async fn bg_stop(task_id: String) -> Result<BgStopResult, String> {
    tauri::async_runtime::spawn_blocking(move || bg_stop_sync(task_id))
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn bg_stop_sync(task_id: String) -> Result<BgStopResult, String> {
    // 1) 短临界区只取 pid / 探一次退出态——等待必须在锁外，否则卡住会连累
    //    bg_list / bg_output / bg_spawn（它们共用同一把 registry 锁）。
    let (pid, already_exited) = {
        let mut registry = registry().lock().map_err(|e| e.to_string())?;
        match registry.get_mut(&task_id) {
            Some(process) => {
                let exited = matches!(process.child.try_wait(), Ok(Some(_)));
                (process.child.id(), exited)
            }
            None => {
                return Ok(BgStopResult {
                    task_id,
                    stopped: false,
                    forced: false,
                    error: None,
                })
            }
        }
    };

    // 2) 锁外终止进程组：TERM → 有界等待 → KILL → 有界等待。
    //    已自然退出则不发信号——避免 pid 已被回收后被误当进程组 id 而伤及无关进程。
    let mut forced = false;
    let mut error = None;
    let mut terminated = already_exited;
    if !terminated {
        error = signal_process_group(pid, false).err();
        terminated = wait_process_group_gone(&task_id, pid, STOP_TERM_GRACE_MS);
        if !terminated {
            forced = true;
            if let Err(escalation) = signal_process_group(pid, true) {
                if error.is_none() {
                    error = Some(escalation);
                }
            }
            terminated = wait_process_group_gone(&task_id, pid, STOP_KILL_GRACE_MS);
        }
    }

    // 3) 仅确认终止才移除注册表项（未能终止则保留——徽标继续如实显示该任务仍在运行）。
    if terminated {
        let mut registry = registry().lock().map_err(|e| e.to_string())?;
        if let Some(mut process) = registry.remove(&task_id) {
            let _ = process.child.try_wait(); // 收割僵尸
        }
    }

    Ok(BgStopResult {
        task_id,
        stopped: terminated,
        forced,
        error: if terminated {
            None
        } else {
            error.or_else(|| Some("进程组在超时后仍未终止".to_string()))
        },
    })
}

/// 列出全部后台任务（刷新用）。
#[tauri::command]
pub async fn bg_list() -> Result<Vec<BgOutput>, String> {
    tauri::async_runtime::spawn_blocking(move || bg_list_sync())
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn bg_list_sync() -> Result<Vec<BgOutput>, String> {
        let mut registry = registry().lock().map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        // 收割 + 逐任务产出状态与尾部输出
        let ids: Vec<String> = registry.keys().cloned().collect();
        for task_id in ids {
            let process = registry.get_mut(&task_id).expect("checked");
            let _ = process.child.try_wait();
            let status = if process.exited.load(Ordering::Relaxed) || is_child_exited(&mut process.child) {
                "exited"
            } else {
                "running"
            };
            let exit_code = process.child.try_wait().ok().flatten().and_then(|s| s.code());
            let buf = process.output.lock().map_err(|e| e.to_string())?;
            let total = buf.len();
            // bg_list 只给尾部 2KB（全量走 bg_output 增量）
            let tail_start = total.saturating_sub(2048);
            let new_output = crate::console_decode::decode_console_bytes(&buf[tail_start..]);
            out.push(BgOutput {
                task_id,
                status: status.to_string(),
                exit_code,
                new_output,
                total_bytes: total,
                dropped_bytes: process.dropped.load(Ordering::Relaxed),
                started_at_ms: process.started_at_ms,
            });
        }
        out.sort_by(|a, b| a.started_at_ms.cmp(&b.started_at_ms));
        Ok(out)
}
