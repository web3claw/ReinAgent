use std::fs;
use std::path::{Path, PathBuf};
use std::io::Read;
use std::time::Duration;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

fn get_default_workspace() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".ReinAgent").join("DefaultProject")
    } else if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile).join(".ReinAgent").join("DefaultProject")
    } else {
        PathBuf::from("/tmp/ReinAgent/DefaultProject")
    }
}

fn resolve_path(raw_path: &str) -> PathBuf {
    let p = Path::new(raw_path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        let default_dir = get_default_workspace();
        default_dir.join(p)
    }
}

#[tauri::command]
pub async fn fs_read_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_path(&path);
        fs::read_to_string(&resolved).map_err(|e| format!("Failed to read {}: {}", resolved.display(), e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 路径存在性探测（终端配置的 shell 自动检测用）。
#[tauri::command]
pub fn fs_path_exists(path: String) -> bool {
    Path::new(path.trim()).exists()
}

/// 从 PATH 解析可用的 shell（P2-G2 终端配置；零硬编码路径——交给系统 where/which）。
/// Windows 用 where.exe 逐个解析；unix 用 which。返回 {名字: 解析路径}（仅含命中的）。
#[tauri::command]
pub fn shell_detect() -> std::collections::BTreeMap<String, String> {
    use std::process::Command;
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &["pwsh.exe", "powershell.exe", "cmd.exe", "bash.exe"]
    } else {
        &["bash", "zsh", "fish", "sh"]
    };
    let mut out = std::collections::BTreeMap::new();
    for name in candidates {
        let probe = if cfg!(target_os = "windows") {
            Command::new("where").arg(name).output()
        } else {
            Command::new("which").arg(name).output()
        };
        if let Ok(output) = probe {
            if output.status.success() {
                let first = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !first.is_empty() {
                    out.insert(name.trim_end_matches(".exe").to_string(), first);
                }
            }
        }
    }
    out
}
#[tauri::command]
pub async fn fs_write_file(
    path: String,
    content: String,
    checkpoint: Option<crate::checkpoint::CheckpointCtx>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_path(&path);
        // 检查点前像捕获（对齐 LiveAgent）：落盘前把被改文件的"前像"记入
        // 会话检查点。尽力而为，失败只记 error 记录，绝不阻断写入。
        if let Some(ctx) = checkpoint.as_ref() {
            capture_write_pre_image(&ctx, &resolved);
        }
        if let Some(parent) = resolved.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&resolved, content).map_err(|e| format!("Failed to write {}: {}", resolved.display(), e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 推导写入目标的检查点（root, rel_path）并捕获前像。
/// 目标必须位于 ctx.root（会话工作区根）之下才捕获——授权根集合只含工作区根，
/// 工作区外的绝对路径本来就无法回退。
fn capture_write_pre_image(ctx: &crate::checkpoint::CheckpointCtx, resolved: &Path) {
    let root = if ctx.root.trim().is_empty() {
        return;
    } else {
        match dunce::canonicalize(resolve_path(ctx.root.trim())) {
            Ok(p) => p,
            Err(_) => return,
        }
    };
    let Ok(rel) = resolved.strip_prefix(&root) else {
        return;
    };
    let pre_image = match fs::symlink_metadata(resolved) {
        Err(_) => crate::checkpoint::PreImage::Missing,
        Ok(md) if md.is_file() => crate::checkpoint::PreImage::File(None),
        Ok(_) => return, // 目标是目录/符号链接等非常规形态：不捕获
    };
    crate::checkpoint::capture_pre_image(Some(ctx), &root, rel, pre_image);
}

/// 清理工作区白名单临时目录 `<workspace>/.ReinAgent/temp/`（整目录递归删除，幂等）。
/// 安防：目标路径必须严格等于 workspace_root/.ReinAgent/temp 两级，拒绝越界。
#[derive(serde::Serialize)]
pub struct CleanTmpResult {
    pub deleted_entries: u32,
}

fn count_tmp_entries(dir: &Path, count: &mut u32) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            *count += 1;
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                count_tmp_entries(&entry.path(), count);
            }
        }
    }
}

#[tauri::command]
pub async fn fs_clean_reinagent_tmp(
    workspace_root: String,
) -> Result<CleanTmpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_path(&workspace_root);
        let target = root.join(".ReinAgent").join("temp");
        // 白名单安防：路径必须严格等于 root/.ReinAgent/temp（两级均固定），拒绝越界。
        if target.file_name().map(|n| n != "temp").unwrap_or(true) {
            return Err("清理目标必须是工作区下的 .ReinAgent/temp 目录".into());
        }
        if target.parent().map(|p| p.file_name().map(|n| n != ".ReinAgent").unwrap_or(true)).unwrap_or(true) {
            return Err("清理目标必须是工作区下的 .ReinAgent/temp 目录".into());
        }
        let meta = match fs::metadata(&target) {
            // 目录不存在：幂等成功（无事可清）。
            Err(_) => return Ok(CleanTmpResult { deleted_entries: 0 }),
            Ok(m) => m,
        };
        if !meta.is_dir() {
            return Err("清理目标不是目录".into());
        }
        let mut deleted_entries: u32 = 0;
        count_tmp_entries(&target, &mut deleted_entries);
        fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to clean {}: {}", target.display(), e))?;
        Ok(CleanTmpResult { deleted_entries })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_list_dir(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_path(&path);
        if !resolved.exists() {
            fs::create_dir_all(&resolved).map_err(|e| e.to_string())?;
        }
        let entries = fs::read_dir(&resolved).map_err(|e| format!("Failed to list {}: {}", resolved.display(), e))?;
        let mut result = Vec::new();
        for entry in entries {
            if let Ok(entry) = entry {
                if let Ok(name) = entry.file_name().into_string() {
                    result.push(name);
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除文件（对齐 LiveAgent fsTools 的 Delete）。
/// 安全链：必须是普通文件（拒绝目录/符号链接）、删除前把前像写入检查点
/// （使「回退本轮代码改动」能恢复被删文件）、失败如实上抛。
#[tauri::command]
pub async fn fs_delete_file(
    path: String,
    checkpoint: Option<crate::checkpoint::CheckpointCtx>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_path(&path);
        let md = fs::symlink_metadata(&resolved)
            .map_err(|e| format!("Failed to stat {}: {}", resolved.display(), e))?;
        if md.file_type().is_symlink() {
            return Err(format!(
                "拒绝删除符号链接（可能是逃逸路径）: {}",
                resolved.display()
            ));
        }
        if !md.is_file() {
            return Err(format!("只允许删除普通文件（目录请用终端命令）: {}", resolved.display()));
        }
        if let Some(ctx) = checkpoint.as_ref() {
            capture_write_pre_image(&ctx, &resolved);
        }
        fs::remove_file(&resolved)
            .map_err(|e| format!("Failed to delete {}: {}", resolved.display(), e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 创建目录（文件管理器面板「新建文件夹」；父目录已存在，不递归建链）。
#[tauri::command]
pub async fn fs_create_dir(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_path(&path);
        if resolved.exists() {
            return Err(format!("目标已存在: {}", resolved.display()));
        }
        let parent = resolved
            .parent()
            .ok_or_else(|| format!("路径无效: {}", resolved.display()))?;
        if !parent.is_dir() {
            return Err(format!("父目录不存在: {}", parent.display()));
        }
        fs::create_dir(&resolved).map_err(|e| format!("Failed to create {}: {}", resolved.display(), e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除任意条目（文件或目录，目录递归）。安防：拒绝符号链接（逃逸路径）；
/// 拒绝删除工作区根自身。文件管理器面板用（fs_delete_file 只收普通文件）。
#[tauri::command]
pub async fn fs_remove_entry(
    path: String,
    workspace_root: String,
    checkpoint: Option<crate::checkpoint::CheckpointCtx>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_path(&path);
        let root = resolve_path(&workspace_root);
        if resolved == root {
            return Err(format!("拒绝删除工作区根目录: {}", resolved.display()));
        }
        let md = fs::symlink_metadata(&resolved)
            .map_err(|e| format!("Failed to stat {}: {}", resolved.display(), e))?;
        if md.file_type().is_symlink() {
            return Err(format!("拒绝删除符号链接（可能是逃逸路径）: {}", resolved.display()));
        }
        if let Some(ctx) = checkpoint.as_ref() {
            capture_write_pre_image(&ctx, &resolved);
        }
        if md.is_dir() {
            fs::remove_dir_all(&resolved)
                .map_err(|e| format!("Failed to delete {}: {}", resolved.display(), e))
        } else {
            fs::remove_file(&resolved)
                .map_err(|e| format!("Failed to delete {}: {}", resolved.display(), e))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 重命名/移动（文件或目录；目标已存在拒绝覆盖）。
/// 安防与 fs_delete_file 同源：源与目标都拒绝符号链接；目标路径不得逃逸（resolve 后
/// 必须仍以源父目录为根——直接用绝对路径解析，用户面板只会传工作区内路径）。
#[tauri::command]
pub async fn fs_rename(
    path: String,
    new_path: String,
    checkpoint: Option<crate::checkpoint::CheckpointCtx>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let from = resolve_path(&path);
        let to = resolve_path(&new_path);
        let from_md = fs::symlink_metadata(&from)
            .map_err(|e| format!("Failed to stat {}: {}", from.display(), e))?;
        if from_md.file_type().is_symlink() {
            return Err(format!("拒绝重命名符号链接（可能是逃逸路径）: {}", from.display()));
        }
        if let Ok(to_md) = fs::symlink_metadata(&to) {
            if to_md.file_type().is_symlink() {
                return Err(format!("目标位置是符号链接（可能是逃逸路径）: {}", to.display()));
            }
            return Err(format!("目标已存在: {}", to.display()));
        }
        if from == to {
            return Ok(());
        }
        // 目标父目录必须存在（不隐式建目录，防止拼错路径到处落盘）
        let to_parent = to
            .parent()
            .ok_or_else(|| format!("目标路径无效: {}", to.display()))?;
        if !to_parent.is_dir() {
            return Err(format!("目标父目录不存在: {}", to_parent.display()));
        }
        if let Some(ctx) = checkpoint.as_ref() {
            capture_write_pre_image(&ctx, &from);
        }
        fs::rename(&from, &to)
            .map_err(|e| format!("Failed to rename {} -> {}: {}", from.display(), to.display(), e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读 kv 代理设置并组装子进程代理环境变量（对齐 ZCode buildAgentProxyEnv /
/// buildAgentNoProxyEnv：显式设置覆盖 shell 继承，空 = 清除代理变量直连）。
pub(crate) fn read_kv_proxy_settings() -> Vec<(String, String)> {
    let (proxy, no_proxy) = if let Ok(conn) = crate::conversation_store::db_conn() {
        let read = |key: &str| -> String {
            conn.query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| {
                row.get::<_, String>(0)
            })
            .unwrap_or_default()
        };
        (read("reinagent-web-proxy"), read("reinagent-web-proxy-no-proxy"))
    } else {
        (String::new(), String::new())
    };
    let proxy_trimmed = proxy.trim().to_string();
    if proxy_trimmed.is_empty() {
        // 留空直连：显式清空，防止继承宿主 shell 的同名变量
        return vec![
            ("HTTP_PROXY".to_string(), String::new()),
            ("HTTPS_PROXY".to_string(), String::new()),
            ("ALL_PROXY".to_string(), String::new()),
            ("NO_PROXY".to_string(), String::new()),
        ];
    }
    let mut env = vec![
        ("HTTP_PROXY".to_string(), proxy_trimmed.clone()),
        ("HTTPS_PROXY".to_string(), proxy_trimmed.clone()),
        ("ALL_PROXY".to_string(), proxy_trimmed),
    ];
    let no_proxy_trimmed = no_proxy.trim().to_string();
    if !no_proxy_trimmed.is_empty() {
        env.push(("NO_PROXY".to_string(), no_proxy_trimmed));
    }
    env
}

#[tauri::command]
pub async fn fs_execute(
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
) -> Result<String, String> {
    // 代理环境注入（P2-G2 代理贯通）：设置非空时子进程显式继承 HTTP(S)_PROXY/
    // NO_PROXY（覆盖系统继承值）；为空时**清除**继承的代理变量——设置页语义
    // 「不读取系统环境变量，留空直连」。
    let _proxy_env = read_kv_proxy_settings();
    tauri::async_runtime::spawn_blocking(move || {
        const EXEC_TIMEOUT_SECS: u64 = 120;
        // 代理环境注入（P2-G2 代理贯通）：设置非空时子进程显式继承 HTTP(S)_PROXY/
        // NO_PROXY（覆盖系统继承值）；为空时**清除**继承的代理变量——设置页语义
        // 「不读取系统环境变量，留空直连」。
        let proxy_env: Vec<(String, String)> = read_kv_proxy_settings();
        // 输出上限（防巨型输出拖垮 IPC 与前端渲染）：256KB
        const OUTPUT_CAP_BYTES: usize = 256 * 1024;
        // 进程退出后等待管道收尾的上限：超时取部分输出（防孙进程持管道永久挂起）
        const DRAIN_JOIN_TIMEOUT_MS: u64 = 5000;
        #[cfg(target_os = "windows")]
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let exec_dir = match cwd {
            Some(ref dir) if !dir.trim().is_empty() => resolve_path(dir),
            _ => get_default_workspace(),
        };

        if !exec_dir.exists() {
            let _ = fs::create_dir_all(&exec_dir);
        }

        // ★ spawn_shell：按所选 shell 分派执行（P2-G2 终端配置贯通——环境段告诉模型
        //   「用 PowerShell 语法」，exec 就必须真的在 PowerShell 里跑）。
        //   pwsh/powershell → -Command；bash/zsh/fish/sh → -c；cmd/未配置 → cmd /C。
        // ★ spawn_shell：按所选 shell 分派执行（P2-G2 终端配置贯通——环境段告诉模型
        //   「用 PowerShell 语法」，exec 就必须真的在 PowerShell 里跑）+ 代理环境注入。
        //   pwsh/powershell → -Command；bash/zsh/fish/sh → -c；cmd/未配置 → cmd /C。
        fn spawn_shell(command: &str, exec_dir: &Path, shell: Option<&str>, proxy_env: &[(String, String)]) -> std::io::Result<std::process::Child> {
            let shell_name = shell.unwrap_or("").trim().to_lowercase();
            let exe_name = shell_name.rsplit(['\\', '/']).next().unwrap_or("");
            let build = |mut cmd: Command| {
                cmd.current_dir(exec_dir);
                cmd.stdout(Stdio::piped());
                cmd.stderr(Stdio::piped());
                for (key, value) in proxy_env {
                    cmd.env(key, value);
                }
                cmd
            };
            #[cfg(target_os = "windows")]
            {
                // ★ raw_arg：命令行原样透传给 cmd /C。普通 arg() 会按 MSVC 规则把内部引号
                //   转义成 \"，而 cmd 不认这种转义——findstr /c:"..." 这类带引号的命令会被
                //   拆坏（表现为 FINDSTR: Cannot open <词>）。
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                if exe_name.starts_with("pwsh") || exe_name.starts_with("powershell") {
                    let mut cmd = build(Command::new(shell.unwrap_or("powershell.exe")));
                    cmd.arg("-NoProfile").arg("-Command").arg(command);
                    cmd.creation_flags(CREATE_NO_WINDOW);
                    return cmd.spawn();
                }
                if exe_name.contains("bash") || exe_name == "zsh" || exe_name == "fish" || exe_name == "sh" {
                    let mut cmd = build(Command::new(shell.unwrap_or("bash.exe")));
                    cmd.arg("-c").arg(command);
                    cmd.creation_flags(CREATE_NO_WINDOW);
                    return cmd.spawn();
                }
                let mut cmd = build(Command::new("cmd"));
                cmd.raw_arg("/C").raw_arg(command);
                cmd.creation_flags(CREATE_NO_WINDOW);
                cmd.spawn()
            }
            #[cfg(not(target_os = "windows"))]
            {
                let shell_exe = if shell_name.is_empty() { "sh".to_string() } else { shell_name };
                let mut cmd = build(Command::new(&shell_exe));
                cmd.arg("-c").arg(command);
                cmd.spawn()
            }
        }

        fn cap_output(mut buf: Vec<u8>) -> Vec<u8> {
            if buf.len() > OUTPUT_CAP_BYTES {
                buf.truncate(OUTPUT_CAP_BYTES);
                let note = b"\n...[output truncated at 256KB]";
                buf.extend_from_slice(note);
            }
            buf
        }

        let mut child = spawn_shell(&command, &exec_dir, shell.as_deref(), &proxy_env).map_err(|e| e.to_string())?;

        // 输出读取放独立线程：进程未退出时也能持续收集，不会因管道缓冲写满而卡死子进程。
        let mut stdout_pipe = child.stdout.take().expect("stdout piped");
        let mut stderr_pipe = child.stderr.take().expect("stderr piped");
        let stdout_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout_pipe.read_to_end(&mut buf);
            buf
        });
        let stderr_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr_pipe.read_to_end(&mut buf);
            buf
        });

        // 轮询等待 + 超时保护：挂起的命令（如管道空输入等待）超时后强杀整棵进程树。
        let started = std::time::Instant::now();
        let timeout = Duration::from_secs(EXEC_TIMEOUT_SECS);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {
                    if started.elapsed() >= timeout {
                        #[cfg(target_os = "windows")]
                        {
                            let pid = child.id();
                            let _ = Command::new("taskkill")
                                .args(["/PID", &pid.to_string(), "/T", "/F"])
                                .creation_flags(CREATE_NO_WINDOW)
                                .status();
                        }
                        #[cfg(not(target_os = "windows"))]
                        {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        break None;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => return Err(format!("Failed to wait for process: {}", e)),
            }
        };

        // 有界收尾：进程已退出，但（可能的）孙进程持管道会让 read_to_end 永不返回——
        // 最多再等 DRAIN_JOIN_TIMEOUT_MS，超时取已收集的部分输出。
        let drain = |handle: std::thread::JoinHandle<Vec<u8>>| -> Vec<u8> {
            let deadline = Duration::from_millis(DRAIN_JOIN_TIMEOUT_MS);
            let started = std::time::Instant::now();
            loop {
                if handle.is_finished() {
                    return handle.join().unwrap_or_default();
                }
                if started.elapsed() >= deadline {
                    return Vec::new(); // 无法安全取回（handle 未完成），放弃输出
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        };
        let stdout = String::from_utf8_lossy(&cap_output(drain(stdout_reader))).to_string();
        let stderr = String::from_utf8_lossy(&cap_output(drain(stderr_reader))).to_string();

        match status {
            Some(status) if status.success() => Ok(stdout),
            Some(status) => Err(format!("Error (exit code {:?}):\n{}{}",
                status.code(), stdout, stderr)),
            // 超时被杀：如实告知并附已收集的部分输出（No-Fallback，不静默吞掉）。
            None => Err(format!("命令执行超时（120 秒），已强制终止。\n{}{}",
                stdout, stderr)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_pick_folder(initial_dir: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new();
        if let Some(dir) = initial_dir {
            let p = resolve_path(&dir);
            if p.is_dir() {
                dialog = dialog.set_directory(p);
            }
        }
        Ok(dialog.pick_folder().map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 返回宿主真实的用户主目录，供前端决议 `~/.ReinAgent/DefaultProject` 默认工作区。
/// 严格 No-Fallback：环境变量缺失时如实报错，严禁编造路径。
#[tauri::command]
pub async fn path_home_dir() -> Result<String, String> {
    if let Ok(home) = std::env::var("USERPROFILE") {
        if !home.trim().is_empty() {
            return Ok(home);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return Ok(home);
        }
    }
    Err("无法获取用户主目录：环境变量 USERPROFILE 与 HOME 均未设置".into())
}


/// 文件预览切片（对齐 ZCode FileTextSlice 结构，供 PreviewPane 消费）。
#[derive(serde::Serialize)]
pub struct FileTextSlice {
    pub path: String,
    pub content: String,
    pub offset: usize,
    pub bytes_read: usize,
    pub total_bytes: usize,
    pub truncated: bool,
    pub is_binary: bool,
}

/// 文件查看器单次读取上限（对齐 ZCode FILE_VIEWER_MAX_TEXT_BYTES = 256KB）。
const FILE_VIEWER_MAX_TEXT_BYTES: usize = 256 * 1024;

/// 二进制探测（对齐 ZCode fileService 口径）：NUL 字节即判定；控制字符占比 > 0.3 判定。
fn looks_like_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(2048)];
    if head.iter().any(|&b| b == 0) {
        return true;
    }
    let sample_len = bytes.len().min(8192);
    if sample_len == 0 {
        return false;
    }
    let control = bytes[..sample_len]
        .iter()
        .filter(|&&b| b < 9 || (b > 13 && b < 32))
        .count();
    (control as f64) / (sample_len as f64) > 0.3
}

/// 读取文本文件切片：供右侧代码预览面板使用（严格 No-Fallback：读取/解析失败如实报错）。
#[tauri::command]
pub async fn fs_read_text_file(
    path: String,
    offset: Option<usize>,
    length: Option<usize>,
) -> Result<FileTextSlice, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_path(&path);
        let meta = fs::metadata(&resolved)
            .map_err(|e| format!("Failed to stat {}: {}", resolved.display(), e))?;
        if meta.is_dir() {
            return Err(format!("{} 是目录，不是文件", resolved.display()));
        }
        let total_bytes = meta.len() as usize;
        let start = offset.unwrap_or(0);
        if start >= total_bytes {
            return Ok(FileTextSlice {
                path: resolved.display().to_string(),
                content: String::new(),
                offset: start,
                bytes_read: 0,
                total_bytes,
                truncated: false,
                is_binary: false,
            });
        }
        use std::io::{Read, Seek, SeekFrom};
        let mut file = fs::File::open(&resolved)
            .map_err(|e| format!("Failed to open {}: {}", resolved.display(), e))?;
        file.seek(SeekFrom::Start(start as u64))
            .map_err(|e| format!("Failed to seek {}: {}", resolved.display(), e))?;
        let requested = length.unwrap_or(FILE_VIEWER_MAX_TEXT_BYTES).min(FILE_VIEWER_MAX_TEXT_BYTES);
        let read_len = requested.min(total_bytes - start);
        let mut bytes = vec![0u8; read_len];
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Failed to read {}: {}", resolved.display(), e))?;
        let is_binary = looks_like_binary(&bytes);
        let truncated = total_bytes - start > read_len;
        let content = if is_binary {
            String::new()
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        };
        Ok(FileTextSlice {
            path: resolved.display().to_string(),
            content,
            offset: start,
            bytes_read: read_len,
            total_bytes,
            truncated,
            is_binary,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ==================== 导入支持（外部 AI 工具会话归档采样 / CC Switch SQLite） ====================

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEndsSlice {
    pub path: String,
    /// 头部完整行（截到最后一个换行为；文件本身更小则原样）
    pub head: String,
    /// 尾部完整行（丢弃首个残行；尾巴从文件头开始则原样）
    pub tail: String,
    pub total_bytes: usize,
    pub mtime_ms: Option<u64>,
}

/// 一次性读文本文件的头/尾字节区间（大归档采样：Codex 头 1MB / 尾 256KB）。
/// 上限各 8MB；utf8 无效字节以替换符呈现（jsonl 均为文本）。
#[tauri::command]
pub async fn fs_read_file_ends(
    path: String,
    head_len: Option<usize>,
    tail_len: Option<usize>,
) -> Result<FileEndsSlice, String> {
    tauri::async_runtime::spawn_blocking(move || {
        const MAX: usize = 8 * 1024 * 1024;
        let resolved = resolve_path(&path);
        let meta = fs::metadata(&resolved)
            .map_err(|e| format!("Failed to stat {}: {}", resolved.display(), e))?;
        if meta.is_dir() {
            return Err(format!("{} 是目录，不是文件", resolved.display()));
        }
        let total = meta.len() as usize;
        let head_len = head_len.unwrap_or(0).min(MAX).min(total);
        let tail_len = tail_len
            .unwrap_or(0)
            .min(MAX)
            .min(total.saturating_sub(head_len));
        use std::io::{Read, Seek, SeekFrom};
        let mut file =
            fs::File::open(&resolved).map_err(|e| format!("Failed to open {}: {}", resolved.display(), e))?;
        let mut head_bytes = vec![0u8; head_len];
        if head_len > 0 {
            file.read_exact(&mut head_bytes)
                .map_err(|e| format!("Failed to read head: {}", e))?;
        }
        let tail_start = total - tail_len;
        let mut tail_bytes = vec![0u8; tail_len];
        if tail_len > 0 {
            file.seek(SeekFrom::Start(tail_start as u64))
                .map_err(|e| format!("Failed to seek tail: {}", e))?;
            file.read_exact(&mut tail_bytes)
                .map_err(|e| format!("Failed to read tail: {}", e))?;
        }
        // 头：截到最后一个完整换行；文件全在头里则原样。
        let head_end = if head_len > 0 && head_len < total {
            head_bytes.iter().rposition(|&b| b == 0x0a).map(|p| p + 1).unwrap_or(0)
        } else {
            head_len
        };
        // 尾：丢掉首个残行；尾巴从文件头（BOF）开始则原样。
        let tail_from = if tail_len > 0 && tail_start > 0 {
            tail_bytes.iter().position(|&b| b == 0x0a).map(|p| p + 1).unwrap_or(tail_bytes.len())
        } else {
            0
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        Ok(FileEndsSlice {
            path: resolved.display().to_string(),
            head: String::from_utf8_lossy(&head_bytes[..head_end]).into_owned(),
            tail: String::from_utf8_lossy(&tail_bytes[tail_from..]).into_owned(),
            total_bytes: total,
            mtime_ms,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 按名字批量查询本进程环境变量（导入解析 `env:VAR` / Codex `env_key` 引用）。
/// 只接受全大写字母/数字/下划线的名字，杜绝任意进程状态探测。
#[tauri::command]
pub async fn import_env_lookup(
    names: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let mut out = std::collections::HashMap::new();
    for name in names {
        let valid = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
        if valid {
            if let Ok(value) = std::env::var(&name) {
                if !value.trim().is_empty() {
                    out.insert(name, value);
                }
            }
        }
    }
    Ok(out)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcSwitchProviderRowRaw {
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub settings_config: String,
}

/// 只读查询 CC Switch 的 `~/.cc-switch/cc-switch.db` providers 表（模型配置导入源）。
/// 文件不存在 = 未安装该工具，返回空数组（常态）；SQL 失败如实报错。
#[tauri::command]
pub async fn ccswitch_read_providers(db_path: String) -> Result<Vec<CcSwitchProviderRowRaw>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !std::path::Path::new(&db_path).exists() {
            return Ok(vec![]);
        }
        let conn = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("Failed to open cc-switch db: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT id, app_type, name, settings_config FROM providers")
            .map_err(|e| format!("cc-switch query failed: {}", e))?;
        let value_to_string = |v: rusqlite::types::Value| -> String {
            use rusqlite::types::Value as V;
            match v {
                V::Null => String::new(),
                V::Integer(i) => i.to_string(),
                V::Real(f) => f.to_string(),
                V::Text(s) => s,
                V::Blob(b) => String::from_utf8_lossy(&b).into_owned(),
            }
        };
        let rows = stmt
            .query_map([], |row| {
                Ok(CcSwitchProviderRowRaw {
                    id: value_to_string(row.get(0)?),
                    app_type: value_to_string(row.get(1)?),
                    name: value_to_string(row.get(2)?),
                    settings_config: value_to_string(row.get(3)?),
                })
            })
            .map_err(|e| format!("cc-switch query failed: {}", e))?;
        let mut out = Vec::new();
        for row in rows {
            match row {
                Ok(r) => out.push(r),
                Err(e) => return Err(format!("cc-switch row read failed: {}", e)),
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ==================== 附件（文件选择 / 图片粘贴） ====================

use base64::Engine as _;

fn detect_image_mime(path: &str) -> Option<&'static str> {
    let lower = path.to_lowercase();
    let ext = lower.rsplit('.').next()?;
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

const IMAGE_PREVIEW_MAX_BYTES: u64 = 5 * 1024 * 1024;
const ATTACHMENT_INLINE_MAX_BYTES: u64 = 25 * 1024 * 1024;

#[derive(serde::Serialize)]
pub struct ImageDataBase64 {
    pub mime: String,
    pub base64: String,
}

/// 原生多选文件对话框（rfd）。取消返回空数组。
#[tauri::command]
pub async fn fs_pick_files(workdir: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new();
        if let Some(dir) = workdir {
            let p = resolve_path(&dir);
            if p.is_dir() {
                dialog = dialog.set_directory(p);
            }
        }
        Ok(dialog
            .pick_files()
            .map(|paths| {
                paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读图片做缩略图预览（≤5MB），返回 mime + base64。
#[tauri::command]
pub async fn fs_read_image_preview(path: String) -> Result<ImageDataBase64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| format!("{}: {}", path, e))?;
        if meta.len() > IMAGE_PREVIEW_MAX_BYTES {
            return Err(format!("图片超过预览大小上限（5 MB）：{}", path));
        }
        let mime = detect_image_mime(&path)
            .ok_or_else(|| format!("不是支持的图片类型（png/jpg/jpeg/gif/webp/bmp）：{}", path))?;
        let data = fs::read(&path).map_err(|e| format!("{}: {}", path, e))?;
        Ok(ImageDataBase64 {
            mime: mime.into(),
            base64: base64::engine::general_purpose::STANDARD.encode(data),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 粘贴图片落盘：base64 解码写入 <workdir>/.ReinAgent/temp/pasted/<时间戳>-<消毒后文件名>，
/// 返回绝对路径（对齐「一次性产物进 .ReinAgent/temp/」约定）。
#[tauri::command]
pub async fn fs_import_pasted_file(
    name: String,
    _mime: String,
    base64_data: String,
    workdir: String,
) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD;
    tauri::async_runtime::spawn_blocking(move || {
        let data = STANDARD
            .decode(base64_data.as_bytes())
            .map_err(|e| format!("base64 解码失败: {}", e))?;
        // 文件名消毒：路径分隔符与 Windows 保留字符
        let sanitized: String = name
            .chars()
            .map(|c| {
                if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        let sanitized = if sanitized.trim().is_empty() {
            "clipboard.png".to_string()
        } else {
            sanitized
        };
        let root = resolve_path(&workdir);
        let dir = root.join(".ReinAgent").join("temp").join("pasted");
        fs::create_dir_all(&dir).map_err(|e| format!("创建暂存目录失败: {}", e))?;
        let target = dir.join(format!("{}-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0), sanitized));
        fs::write(&target, &data).map_err(|e| format!("写入失败: {}", e))?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读附件内容（发送时图片内联用，≤25MB），mime 按扩展名推断（非图片为 octet-stream）。
#[tauri::command]
pub async fn fs_read_attachment_base64(path: String) -> Result<ImageDataBase64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| format!("{}: {}", path, e))?;
        if meta.len() > ATTACHMENT_INLINE_MAX_BYTES {
            return Err(format!("附件超过内联大小上限（25 MB）：{}", path));
        }
        let mime = detect_image_mime(&path).unwrap_or("application/octet-stream");
        let data = fs::read(&path).map_err(|e| format!("{}: {}", path, e))?;
        Ok(ImageDataBase64 {
            mime: mime.into(),
            base64: base64::engine::general_purpose::STANDARD.encode(data),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
