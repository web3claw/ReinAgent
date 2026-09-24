use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

#[tauri::command]
pub async fn fs_write_file(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_path(&path);
        if let Some(parent) = resolved.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&resolved, content).map_err(|e| format!("Failed to write {}: {}", resolved.display(), e))
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

#[tauri::command]
pub async fn fs_execute(command: String, cwd: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shell = if cfg!(target_os = "windows") { "cmd" } else { "sh" };
        let flag = if cfg!(target_os = "windows") { "/C" } else { "-c" };

        let exec_dir = match cwd {
            Some(ref dir) if !dir.trim().is_empty() => resolve_path(dir),
            _ => get_default_workspace(),
        };

        if !exec_dir.exists() {
            let _ = fs::create_dir_all(&exec_dir);
        }

        let mut cmd = Command::new(shell);
        cmd.arg(flag).arg(&command);
        cmd.current_dir(&exec_dir);

        let output = cmd.output().map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if output.status.success() {
            Ok(stdout)
        } else {
            Err(format!("Error (exit code {:?}):\n{}{}", output.status.code(), stdout, stderr))
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
