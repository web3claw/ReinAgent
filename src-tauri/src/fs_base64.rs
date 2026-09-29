//! 任意文件的 base64 读取（P2-E：Office/PPTX 预览数据源）。
//! 上限 64 MB（与 PPTX_MAX_FILE_BYTES 对齐）；二进制安全（hand-rolled 编码避免
//! 分块拼接开销）。

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::Serialize;
use std::fs;

/// 预览用 base64 读取上限：64 MB（PPTX 的上限）。
const PREVIEW_BASE64_MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize)]
pub struct Base64FileResult {
    pub base64: String,
    pub total_bytes: u64,
}

pub(crate) fn read_base64_file_sync(path: &str) -> Result<Base64FileResult, String> {
    let meta = fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
    if meta.len() > PREVIEW_BASE64_MAX_BYTES {
        return Err(format!("文件超过预览大小上限（64 MB）：{path}"));
    }
    let bytes = fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    let total = bytes.len() as u64;
    Ok(Base64FileResult {
        base64: BASE64_STANDARD.encode(bytes),
        total_bytes: total,
    })
}

#[tauri::command]
pub async fn fs_read_base64_file(path: String) -> Result<Base64FileResult, String> {
    tauri::async_runtime::spawn_blocking(move || read_base64_file_sync(&path))
        .await
        .map_err(|e| e.to_string())?
}
