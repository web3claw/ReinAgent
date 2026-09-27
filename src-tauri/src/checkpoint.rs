//! 会话级文件检查点（对齐 LiveAgent checkpoint.rs）：fs 写入命令在落盘前把被改
//! 文件的"前像"存到 `~/.ReinAgent/checkpoints/<taskId>/`，供 rewind 把工作区回退到
//! 某轮开始前的状态。
//!
//! 设计要点（schema v2，与 LiveAgent 一致）：
//! - 捕获发生在 fs 命令实现内部（与变更同一次调用），不引入额外 IPC。
//! - 记录只存 `root + relPath`；回退时要求 root 仍在授权根集合内、root 自身不是
//!   符号链接，再逐级拒绝路径链上的符号链接与（Unix）多硬链接目标；写入前紧邻
//!   再校验一次整条链，落盘走临时文件 + 原子 rename，并携带预览时的状态指纹
//!   （内容哈希 + Unix 权限位）做 TOCTOU 冲突检测（缺指纹一律判冲突而非覆盖）。
//! - turn 身份：TS 侧只传稳定的 turnId（用户消息 ID），turn_seq 由本模块在
//!   INDEX_LOCK 下按会话单调分配——时钟回拨/重复 ID 都不会打乱回退顺序。
//! - blob 是原始字节拷贝，索引是追加式 index.jsonl；回退正确性来自
//!   "每个路径取 turn_seq >= target 的最早一条记录"。
//! - 索引物理上只追加不截断，但语义上会剪枝：完整成功的回退写下 turn_seq=target
//!   的 kind="rewind" 标记，读取侧据此丢弃 >= target 的"陈旧未来"记录；部分成功
//!   写 turn_seq=0 的标记，只审计、不剪枝。
//! - 捕获是尽力而为：内部错误只追加 kind="error" 记录，绝不让文件写入失败。
//! - 容量防线：单文件 32MB、会话总量 512MB、记录 10000 条（尾部 64 条留给 error）。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 单个前像 blob 的大小上限；超过只记 error（该轮标记不完整）。
const MAX_BLOB_BYTES: u64 = 32 * 1024 * 1024;
/// 单会话 blob 总量上限（按索引里 file 记录的 size 求和估算）。
const MAX_TOTAL_BLOB_BYTES: u64 = 512 * 1024 * 1024;
/// 单会话索引记录条数上限；超过后连 error 记录也不再追加（防索引自身膨胀）。
const MAX_RECORDS_PER_CONVERSATION: usize = 10_000;
/// 条数上限里给 error 记录预留的尾部名额。
const RECORD_CAP_ERROR_RESERVE: usize = 64;

/// TS 侧随 fs 变更命令附带的检查点上下文；缺省（None）表示该调用不捕获。
/// root 是捕获时的会话工作区根（用于推导 rel_path）；turnId 是用户消息的稳定 ID。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCtx {
    pub conversation_id: String,
    pub turn_id: String,
    #[serde(default)]
    pub root: String,
}

/// index.jsonl 里的一条记录（schema v2）。
/// kind: "turn" | "file" | "dir" | "error"(捕获失败) | "rewind"(回退审计标记)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRecord {
    pub schema: u32,
    pub turn_seq: u64,
    pub turn_id: String,
    /// 捕获时已解析（canonicalize 过）的根目录，回退时重新校验。
    pub root: String,
    /// 相对 root 的路径，正斜杠分隔；error/rewind 记录可为空串。
    pub rel_path: String,
    pub kind: String,
    pub existed_before: bool,
    /// blobs/ 目录下的文件名；非 file 记录或 existed_before=false 时为空。
    pub blob: Option<String>,
    pub size: u64,
    pub mtime_ms: u64,
    pub captured_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Unix 权限位（仅 file 记录、仅 Unix 捕获时写入）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
}

/// 捕获时携带的前像内容。
pub enum PreImage<'a> {
    /// 变更前文件不存在（回退 = 删除该文件）。
    Missing,
    /// 变更前是普通文件；None 表示由捕获方自行从磁盘读取。
    File(Option<&'a [u8]>),
    /// 变更前是目录（递归删除）；只能记标记，无法恢复。
    Dir,
}

// index.jsonl 的"读检查 + 追加"必须互斥：并发 fs 命令可能同轮同文件竞争，
// turn_seq 的分配也依赖这把锁保证单调。回退期间也要一直持有。
// 守的是 `()`，没有会被 panic 损坏的不变量，中毒时直接 into_inner() 恢复。
static INDEX_LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

/// conversationId 会成为目录名，防御性过滤到安全字符集。
fn sanitize_conversation_id(id: &str) -> Option<String> {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('.').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn home_dir() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("USERPROFILE") {
        if !home.trim().is_empty() {
            return Ok(PathBuf::from(home));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return Ok(PathBuf::from(home));
        }
    }
    Err("Failed to locate the user home directory".to_string())
}

fn checkpoints_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".ReinAgent").join("checkpoints"))
}

fn conversation_dir(conversation_id: &str) -> Result<PathBuf, String> {
    let safe = sanitize_conversation_id(conversation_id)
        .ok_or_else(|| "checkpoint conversationId is empty".to_string())?;
    Ok(checkpoints_root()?.join(safe))
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join("index.jsonl")
}

fn blobs_dir(dir: &Path) -> PathBuf {
    dir.join("blobs")
}

/// Unix 下把检查点目录/文件收紧为仅属主可读写；Windows 无 POSIX 位，跳过。
#[cfg(unix)]
fn tighten_permissions(path: &Path, is_dir: bool) {
    use std::os::unix::fs::PermissionsExt;
    let mode = if is_dir { 0o700 } else { 0o600 };
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn tighten_permissions(_path: &Path, _is_dir: bool) {}

/// 捕获前像时记下 Unix 权限位；Windows 没有 POSIX 位，恒为 None。
#[cfg(unix)]
fn file_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).ok().map(|md| md.permissions().mode())
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> Option<u32> {
    None
}

/// 回退写回内容后还原权限位。老记录没有这个字段就保持现状。
#[cfg(unix)]
fn restore_file_mode(path: &Path, mode: Option<u32>) {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
}

#[cfg(not(unix))]
fn restore_file_mode(_path: &Path, _mode: Option<u32>) {}

fn ensure_conversation_dirs(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    tighten_permissions(dir, true);
    let blobs = blobs_dir(dir);
    fs::create_dir_all(&blobs).map_err(|e| e.to_string())?;
    tighten_permissions(&blobs, true);
    Ok(())
}

fn path_hash16(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    hex_encode(&digest)[..16].to_string()
}

fn read_index(dir: &Path) -> Vec<CheckpointRecord> {
    let Ok(text) = fs::read_to_string(index_path(dir)) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<CheckpointRecord>(line).ok())
        .filter(|record| record.schema == 2)
        .collect()
}

fn append_record(dir: &Path, record: &CheckpointRecord) -> Result<(), String> {
    let line = serde_json::to_string(record).map_err(|e| e.to_string())?;
    let path = index_path(dir);
    let existed = path.exists();
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(format!("{line}\n").as_bytes())
        .map_err(|e| e.to_string())?;
    if !existed {
        tighten_permissions(&path, false);
    }
    Ok(())
}

/// 在 blobs/ 下找下一个空闲版本号写入。同一路径的版本极少，线性探测足够。
fn write_blob(dir: &Path, key: &str, bytes: &[u8]) -> Result<String, String> {
    let blobs = blobs_dir(dir);
    let hash = path_hash16(key);
    for version in 1..u32::MAX {
        let name = format!("{hash}@v{version}");
        let target = blobs.join(&name);
        if target.exists() {
            continue;
        }
        fs::write(&target, bytes).map_err(|e| e.to_string())?;
        tighten_permissions(&target, false);
        return Ok(name);
    }
    Err("checkpoint blob version space exhausted".to_string())
}

/// 记录的稳定键：root + 相对路径，用于 blob 命名与冲突检测的往返匹配。
fn record_key(root: &str, rel_path: &str) -> String {
    format!("{root}\u{1}{rel_path}")
}

fn normalize_root(root: &Path) -> String {
    root.to_string_lossy().replace('\\', "/")
}

fn normalize_rel(rel: &Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}

/// 在 INDEX_LOCK 下解析本轮的 turn_seq：同 turnId 复用，否则 max+1。
fn resolve_turn_seq(records: &[CheckpointRecord], turn_id: &str) -> u64 {
    if let Some(existing) = records
        .iter()
        .find(|r| r.kind != "rewind" && r.turn_id == turn_id)
    {
        return existing.turn_seq;
    }
    records.iter().map(|r| r.turn_seq).max().unwrap_or(0) + 1
}

/// 捕获失败时的兜底：追加 error 记录让该轮显示"不完整"。
fn append_error_record(
    dir: &Path,
    turn_seq: u64,
    turn_id: &str,
    root: &str,
    rel_path: &str,
    reason: &str,
) {
    let record = CheckpointRecord {
        schema: 2,
        turn_seq,
        turn_id: turn_id.to_string(),
        root: root.to_string(),
        rel_path: rel_path.to_string(),
        kind: "error".to_string(),
        existed_before: false,
        blob: None,
        size: 0,
        mtime_ms: 0,
        captured_at: now_ms(),
        note: Some(reason.to_string()),
        mode: None,
    };
    if let Err(e) = append_record(dir, &record) {
        eprintln!("checkpoint error-record append failed for {rel_path}: {e}");
    }
}

/// 目录可注入的捕获实现，便于单测绕过 home 解析。
fn capture_at(
    dir: &Path,
    turn_id: &str,
    root: &Path,
    rel_path: &Path,
    pre_image: PreImage,
) -> Result<u64, String> {
    capture_at_with_limits(
        dir,
        turn_id,
        root,
        rel_path,
        pre_image,
        MAX_BLOB_BYTES,
        MAX_TOTAL_BLOB_BYTES,
    )
}

fn capture_at_with_limits(
    dir: &Path,
    turn_id: &str,
    root: &Path,
    rel_path: &Path,
    pre_image: PreImage,
    max_blob_bytes: u64,
    max_total_blob_bytes: u64,
) -> Result<u64, String> {
    ensure_conversation_dirs(dir)?;
    let root_str = normalize_root(root);
    let rel_str = normalize_rel(rel_path);
    let abs_path = root.join(rel_path);

    let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let existing = read_index(dir);
    let turn_seq = resolve_turn_seq(&existing, turn_id);

    // 记录条数上限：普通捕获提前停住，把尾部名额留给 error 记录。
    if existing.len() + RECORD_CAP_ERROR_RESERVE >= MAX_RECORDS_PER_CONVERSATION {
        return Err(format!(
            "checkpoint record cap reached ({MAX_RECORDS_PER_CONVERSATION})"
        ));
    }

    // 同一轮里同一路径只留最早一条：回退取的就是它，后续记录纯属冗余。
    if existing
        .iter()
        .any(|r| r.turn_seq == turn_seq && r.root == root_str && r.rel_path == rel_str)
    {
        return Ok(turn_seq);
    }

    let record = match pre_image {
        PreImage::Missing => CheckpointRecord {
            schema: 2,
            turn_seq,
            turn_id: turn_id.to_string(),
            root: root_str,
            rel_path: rel_str,
            kind: "file".to_string(),
            existed_before: false,
            blob: None,
            size: 0,
            mtime_ms: 0,
            captured_at: now_ms(),
            note: None,
            mode: None,
        },
        PreImage::Dir => CheckpointRecord {
            schema: 2,
            turn_seq,
            turn_id: turn_id.to_string(),
            root: root_str,
            rel_path: rel_str,
            kind: "dir".to_string(),
            existed_before: true,
            blob: None,
            size: 0,
            mtime_ms: 0,
            captured_at: now_ms(),
            note: None,
            mode: None,
        },
        PreImage::File(bytes) => {
            let owned;
            let bytes = match bytes {
                Some(b) => b,
                None => {
                    // 先看元数据再读盘：超限文件不该为了记一条 error 而被整个读进内存。
                    let len = fs::metadata(&abs_path).map_err(|e| e.to_string())?.len();
                    if len > max_blob_bytes {
                        append_error_record(
                            dir,
                            turn_seq,
                            turn_id,
                            &root_str,
                            &rel_str,
                            &format!("file too large to checkpoint ({len} bytes)"),
                        );
                        return Ok(turn_seq);
                    }
                    owned = fs::read(&abs_path).map_err(|e| e.to_string())?;
                    &owned
                }
            };
            if bytes.len() as u64 > max_blob_bytes {
                append_error_record(
                    dir,
                    turn_seq,
                    turn_id,
                    &root_str,
                    &rel_str,
                    &format!("file too large to checkpoint ({} bytes)", bytes.len()),
                );
                return Ok(turn_seq);
            }
            let total: u64 = existing
                .iter()
                .filter(|r| r.blob.is_some())
                .map(|r| r.size)
                .sum();
            if total.saturating_add(bytes.len() as u64) > max_total_blob_bytes {
                append_error_record(
                    dir,
                    turn_seq,
                    turn_id,
                    &root_str,
                    &rel_str,
                    "conversation checkpoint storage cap reached",
                );
                return Ok(turn_seq);
            }
            let mtime_ms = fs::symlink_metadata(&abs_path)
                .ok()
                .and_then(|md| md.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
                .unwrap_or(0);
            let size = bytes.len() as u64;
            let mode = file_mode(&abs_path);
            let blob = write_blob(dir, &record_key(&root_str, &rel_str), bytes)?;
            CheckpointRecord {
                schema: 2,
                turn_seq,
                turn_id: turn_id.to_string(),
                root: root_str,
                rel_path: rel_str,
                kind: "file".to_string(),
                existed_before: true,
                blob: Some(blob),
                size,
                mtime_ms,
                captured_at: now_ms(),
                note: None,
                mode,
            }
        }
    };

    append_record(dir, &record)?;
    Ok(turn_seq)
}

fn capture_inner(
    ctx: &CheckpointCtx,
    root: &Path,
    rel_path: &Path,
    pre_image: PreImage,
) -> Result<(), String> {
    let dir = conversation_dir(&ctx.conversation_id)?;
    capture_at(&dir, &ctx.turn_id, root, rel_path, pre_image).map(|_| ())
}

/// 把"这个路径没能拿到前像"如实写进索引：该轮在 UI 上显示不完整。
fn record_capture_skip(ctx: &CheckpointCtx, root: &Path, rel_path: &Path, reason: &str) {
    let Ok(dir) = conversation_dir(&ctx.conversation_id) else {
        return;
    };
    if ensure_conversation_dirs(&dir).is_err() {
        return;
    }
    let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let existing = read_index(&dir);
    if existing.len() >= MAX_RECORDS_PER_CONVERSATION {
        eprintln!(
            "checkpoint record cap reached; dropping skip record for {}",
            root.join(rel_path).display()
        );
        return;
    }
    let seq = resolve_turn_seq(&existing, &ctx.turn_id);
    append_error_record(
        &dir,
        seq,
        &ctx.turn_id,
        &normalize_root(root),
        &normalize_rel(rel_path),
        reason,
    );
}

/// fs 写入命令的捕获入口：尽力而为，失败追加 error 记录 + 日志，
/// 绝不阻断文件写入本身。
pub fn capture_pre_image(
    ctx: Option<&CheckpointCtx>,
    root: &Path,
    rel_path: &Path,
    pre_image: PreImage,
) {
    let Some(ctx) = ctx else { return };
    if let Err(error) = capture_inner(ctx, root, rel_path, pre_image) {
        eprintln!(
            "checkpoint capture failed for {}: {error}",
            root.join(rel_path).display()
        );
        record_capture_skip(ctx, root, rel_path, &error);
    }
}

// ---------------------------------------------------------------------------
// 轮边界与查询命令
// ---------------------------------------------------------------------------

fn begin_turn_at(dir: &Path, turn_id: &str) -> Result<(), String> {
    let turn_id = turn_id.trim();
    if turn_id.is_empty() {
        return Err("checkpoint turnId is empty".to_string());
    }
    ensure_conversation_dirs(dir)?;
    let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let existing = read_index(dir);
    if existing.iter().any(|record| record.turn_id == turn_id) {
        return Ok(());
    }
    if existing.len() + RECORD_CAP_ERROR_RESERVE >= MAX_RECORDS_PER_CONVERSATION {
        return Err(format!(
            "checkpoint record cap reached ({MAX_RECORDS_PER_CONVERSATION})"
        ));
    }
    let turn_seq = resolve_turn_seq(&existing, turn_id);
    append_record(
        dir,
        &CheckpointRecord {
            schema: 2,
            turn_seq,
            turn_id: turn_id.to_string(),
            root: String::new(),
            rel_path: String::new(),
            kind: "turn".to_string(),
            existed_before: false,
            blob: None,
            size: 0,
            mtime_ms: 0,
            captured_at: now_ms(),
            note: None,
            mode: None,
        },
    )
}

#[tauri::command]
pub async fn checkpoint_begin_turn(conversation_id: String, turn_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = conversation_dir(&conversation_id)?;
        begin_turn_at(&dir, &turn_id)
    })
    .await
    .map_err(|e| format!("checkpoint_begin_turn join failed: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointTurnSummary {
    pub turn_seq: u64,
    pub turn_id: String,
    pub file_count: usize,
    pub dir_count: usize,
    /// 该轮是否有捕获失败的记录（回退可能不完整）。
    pub incomplete: bool,
    pub first_captured_at: u64,
}

/// 索引的"活记录"视图：剔除被回退作废的陈旧未来轮。
fn live_records(records: Vec<CheckpointRecord>) -> Vec<CheckpointRecord> {
    let mut out: Vec<CheckpointRecord> = Vec::new();
    for record in records {
        if record.kind == "rewind" {
            if record.turn_seq > 0 {
                out.retain(|r| r.turn_seq < record.turn_seq);
            }
            continue;
        }
        out.push(record);
    }
    out
}

/// 会话内可回退的轮列表，按 turn_seq 升序。
fn checkpoint_turn_summaries(records: Vec<CheckpointRecord>) -> Vec<CheckpointTurnSummary> {
    let records = live_records(records);
    let mut turns: Vec<CheckpointTurnSummary> = Vec::new();
    for record in records {
        let summary = match turns.iter_mut().find(|t| t.turn_seq == record.turn_seq) {
            Some(existing) => existing,
            None => {
                turns.push(CheckpointTurnSummary {
                    turn_seq: record.turn_seq,
                    turn_id: record.turn_id.clone(),
                    file_count: 0,
                    dir_count: 0,
                    incomplete: false,
                    first_captured_at: record.captured_at,
                });
                turns.last_mut().expect("just pushed")
            }
        };
        match record.kind.as_str() {
            "dir" => summary.dir_count += 1,
            "error" => summary.incomplete = true,
            "file" => summary.file_count += 1,
            // "turn" 边界记录与未知类型都不计数，只把该轮钉进列表。
            _ => {}
        }
        if record.captured_at < summary.first_captured_at {
            summary.first_captured_at = record.captured_at;
        }
    }
    turns.sort_by_key(|t| t.turn_seq);
    turns
}

#[tauri::command]
pub async fn checkpoint_list(
    conversation_id: String,
) -> Result<Vec<CheckpointTurnSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = conversation_dir(&conversation_id)?;
        Ok(checkpoint_turn_summaries(read_index(&dir)))
    })
    .await
    .map_err(|e| format!("checkpoint_list join failed: {e}"))?
}

// ---------------------------------------------------------------------------
// 预览（diff stats）
// ---------------------------------------------------------------------------

/// 回退到某轮开始前的状态时，每个受影响路径的动作与当前脏度。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffEntry {
    /// 展示用路径（root/rel）。
    pub path: String,
    /// 冲突检测的往返键：UI 把 (key, currentHash) 原样带回 rewind。
    pub key: String,
    /// "restore" | "delete" | "clean" | "skip-dir" | "missing-blob" | "unresolvable"
    pub action: String,
    /// 预览时目标文件的状态指纹；不存在时为 "absent"。不可解析时为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_hash: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffStats {
    pub turn_seq: u64,
    pub restore_files: usize,
    pub delete_files: usize,
    pub clean_files: usize,
    pub skipped_dirs: usize,
    pub missing_blobs: usize,
    pub unresolvable_files: usize,
    pub capture_errors: usize,
    pub entries: Vec<CheckpointDiffEntry>,
}

/// 取 turn_seq >= target 的可恢复记录，每路径保留最早一条。
fn earliest_records_since(dir: &Path, turn_seq: u64) -> (Vec<CheckpointRecord>, usize) {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<CheckpointRecord> = Vec::new();
    let mut errors = 0usize;
    for record in live_records(read_index(dir)) {
        if record.turn_seq < turn_seq {
            continue;
        }
        if record.kind == "error" {
            errors += 1;
            continue;
        }
        if record.kind == "turn" {
            continue;
        }
        let key = record_key(&record.root, &record.rel_path);
        if seen.iter().any(|p| p == &key) {
            continue;
        }
        seen.push(key);
        out.push(record);
    }
    (out, errors)
}

/// 调用方给出的"当前仍然授权的工作区根"归一化：自身是符号链接的根不予采信，
/// 其余 canonicalize 后去重。空集合意味着任何记录都无法回退（fail-closed）。
fn canonical_authorized_roots(roots: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for raw in roots {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = Path::new(trimmed);
        if matches!(fs::symlink_metadata(path), Ok(md) if md.file_type().is_symlink()) {
            continue;
        }
        // dunce：Windows 上取普通路径而非 \\?\ verbatim 前缀，便于展示与比对。
        if let Ok(canonical) = dunce::canonicalize(path) {
            if !out.contains(&canonical) {
                out.push(canonical);
            }
        }
    }
    out
}

/// 回退授权链的第一环：记录里的 root 必须仍是当前授权工作区根之一。
fn resolve_authorized_root(
    root_str: &str,
    authorized_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let raw = Path::new(root_str);
    match fs::symlink_metadata(raw) {
        Ok(md) if md.file_type().is_symlink() => {
            return Err("refusing to follow a symlinked checkpoint root".to_string());
        }
        Ok(md) if !md.is_dir() => {
            return Err("checkpoint root is no longer a directory".to_string());
        }
        Ok(_) => {}
        Err(e) => return Err(format!("checkpoint root unavailable: {e}")),
    }
    let root =
        dunce::canonicalize(raw).map_err(|e| format!("checkpoint root unavailable: {e}"))?;
    if !authorized_roots.iter().any(|allowed| allowed == &root) {
        return Err("checkpoint root is not an authorized workspace root".to_string());
    }
    Ok(root)
}

/// 回退目标的重新校验：根必须仍在授权集合内且不是符号链接，相对路径重新
/// 过滤（仅 Normal 分量），并逐级拒绝路径链上的符号链接。
fn resolve_rewind_target(
    root_str: &str,
    rel_str: &str,
    authorized_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let root = resolve_authorized_root(root_str, authorized_roots)?;
    let rel = PathBuf::from(rel_str);
    if rel.as_os_str().is_empty() {
        return Err("empty relative path".to_string());
    }
    for comp in rel.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return Err(format!("unsafe relative path: {rel_str}")),
        }
    }
    let mut current = root;
    for comp in rel.components() {
        current.push(comp);
        match fs::symlink_metadata(&current) {
            Ok(md) if md.file_type().is_symlink() => {
                return Err(format!("refusing to follow symlink at {}", current.display()));
            }
            _ => {}
        }
    }
    Ok(current)
}

/// Unix 下拒绝恢复/删除多硬链接文件。
#[cfg(unix)]
fn reject_multi_hardlink(md: &fs::Metadata) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if md.nlink() > 1 {
        return Err("refusing to modify a multi-hardlink file".to_string());
    }
    Ok(())
}

#[cfg(not(unix))]
fn reject_multi_hardlink(_md: &fs::Metadata) -> Result<(), String> {
    Ok(())
}

/// 目标当前状态的指纹：内容哈希 + (Unix)权限位；不存在返回 "absent"。
fn current_state_hash(target: &Path) -> String {
    match fs::symlink_metadata(target) {
        Ok(md) if md.is_file() => match fs::read(target) {
            Ok(bytes) => match file_mode(target) {
                Some(mode) => format!("{}@{:o}", sha256_hex(&bytes), mode),
                None => sha256_hex(&bytes),
            },
            Err(_) => "unreadable".to_string(),
        },
        Ok(_) => "non-file".to_string(),
        Err(_) => "absent".to_string(),
    }
}

/// 记录的 mode 与目标现状是否不一致。
fn mode_differs(recorded: Option<u32>, target: &Path) -> bool {
    match recorded {
        Some(want) => matches!(file_mode(target), Some(have) if have != want),
        None => false,
    }
}

fn classify_entry(
    dir: &Path,
    record: &CheckpointRecord,
    authorized_roots: &[PathBuf],
) -> CheckpointDiffEntry {
    let key = record_key(&record.root, &record.rel_path);
    let display = format!("{}/{}", record.root, record.rel_path);
    if record.kind == "dir" {
        return CheckpointDiffEntry {
            path: display,
            key,
            action: "skip-dir".to_string(),
            current_hash: None,
        };
    }
    let target = match resolve_rewind_target(&record.root, &record.rel_path, authorized_roots) {
        Ok(target) => target,
        Err(_) => {
            return CheckpointDiffEntry {
                path: display,
                key,
                action: "unresolvable".to_string(),
                current_hash: None,
            };
        }
    };
    let hash = current_state_hash(&target);
    let action = if !record.existed_before {
        if hash == "absent" {
            "clean"
        } else {
            "delete"
        }
    } else {
        match &record.blob {
            None => "missing-blob",
            Some(blob) => match fs::read(blobs_dir(dir).join(blob)) {
                Err(_) => "missing-blob",
                Ok(expected) => {
                    let current_content = hash.split_once('@').map_or(hash.as_str(), |(c, _)| c);
                    if sha256_hex(&expected) == current_content
                        && !mode_differs(record.mode, &target)
                    {
                        "clean"
                    } else {
                        "restore"
                    }
                }
            },
        }
    };
    // 目标可解析的条目一律回传现状哈希（含 clean / missing-blob）：
    // rewind 侧对缺哈希的条目一律判冲突，少回传一个就等于放弃一条防线。
    CheckpointDiffEntry {
        path: display,
        key,
        action: action.to_string(),
        current_hash: Some(hash),
    }
}

#[tauri::command]
pub async fn checkpoint_diff_stats(
    conversation_id: String,
    turn_seq: u64,
    authorized_roots: Vec<String>,
) -> Result<CheckpointDiffStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = conversation_dir(&conversation_id)?;
        let authorized = canonical_authorized_roots(&authorized_roots);
        let (records, capture_errors) = earliest_records_since(&dir, turn_seq);
        let mut stats = CheckpointDiffStats {
            turn_seq,
            restore_files: 0,
            delete_files: 0,
            clean_files: 0,
            skipped_dirs: 0,
            missing_blobs: 0,
            unresolvable_files: 0,
            capture_errors,
            entries: Vec::new(),
        };
        for record in records {
            let entry = classify_entry(&dir, &record, &authorized);
            match entry.action.as_str() {
                "restore" => stats.restore_files += 1,
                "delete" => stats.delete_files += 1,
                "clean" => stats.clean_files += 1,
                "skip-dir" => stats.skipped_dirs += 1,
                "missing-blob" => stats.missing_blobs += 1,
                "unresolvable" => stats.unresolvable_files += 1,
                _ => {}
            }
            stats.entries.push(entry);
        }
        Ok(stats)
    })
    .await
    .map_err(|e| format!("checkpoint_diff_stats join failed: {e}"))?
}

// ---------------------------------------------------------------------------
// 回退命令
// ---------------------------------------------------------------------------

/// UI 从 diff 预览带回的 (key, currentHash) 期望值，rewind 前重新比对。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointExpectedEntry {
    pub key: String,
    pub current_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRewindResult {
    pub turn_seq: u64,
    pub restored_files: usize,
    pub deleted_files: usize,
    pub clean_files: usize,
    pub skipped_dirs: usize,
    pub capture_errors: usize,
    pub conflicts: Vec<String>,
    pub failed: Vec<String>,
}

/// 一次回退是否"完整"：只有完整回退才允许写剪枝标记。
fn rewind_is_complete(result: &CheckpointRewindResult) -> bool {
    result.conflicts.is_empty()
        && result.failed.is_empty()
        && result.skipped_dirs == 0
        && result.capture_errors == 0
}

/// 临时文件 + 原子 rename 落盘。Windows 上 rename 不覆盖已存在目标时，
/// 先把旧文件挪到备份名再 rename，失败回滚备份，任何一步都至少保住一份完整内容。
fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "target has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".ckpt-tmp-{}-{}", std::process::id(), now_ms()));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    match fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(_) if target.exists() => {
            let backup = parent.join(format!(".ckpt-bak-{}-{}", std::process::id(), now_ms()));
            if let Err(e) = fs::rename(target, &backup) {
                let _ = fs::remove_file(&tmp);
                return Err(e.to_string());
            }
            match fs::rename(&tmp, target) {
                Ok(()) => {
                    let _ = fs::remove_file(&backup);
                    Ok(())
                }
                Err(e) => {
                    let _ = fs::rename(&backup, target);
                    let _ = fs::remove_file(&tmp);
                    Err(e.to_string())
                }
            }
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

/// 校验与动作之间存在窗口期，所以在真正写/删之前紧邻重跑一次授权链。
fn reverify_target(
    record: &CheckpointRecord,
    target: &Path,
    authorized_roots: &[PathBuf],
) -> Result<(), String> {
    let again = resolve_rewind_target(&record.root, &record.rel_path, authorized_roots)?;
    if again != target {
        return Err("checkpoint target changed during rewind".to_string());
    }
    Ok(())
}

/// 把 turn_seq >= target 的所有被改文件恢复到各自最早的前像。
fn rewind_at(
    dir: &Path,
    turn_seq: u64,
    authorized_roots: &[PathBuf],
    expected: Option<&[CheckpointExpectedEntry]>,
) -> CheckpointRewindResult {
    let expected_by_key: Option<HashMap<&str, &str>> = expected.map(|entries| {
        entries
            .iter()
            .map(|e| (e.key.as_str(), e.current_hash.as_str()))
            .collect()
    });
    let (records, capture_errors) = earliest_records_since(dir, turn_seq);
    let mut result = CheckpointRewindResult {
        turn_seq,
        restored_files: 0,
        deleted_files: 0,
        clean_files: 0,
        skipped_dirs: 0,
        capture_errors,
        conflicts: Vec::new(),
        failed: Vec::new(),
    };
    for record in records {
        let display = format!("{}/{}", record.root, record.rel_path);
        if record.kind == "dir" {
            result.skipped_dirs += 1;
            continue;
        }
        let target = match resolve_rewind_target(&record.root, &record.rel_path, authorized_roots) {
            Ok(t) => t,
            Err(e) => {
                result.failed.push(format!("{display}: {e}"));
                continue;
            }
        };
        // TOCTOU 防护：与预览时的状态指纹比对。缺失该键一律判冲突，绝不 fail-open。
        // "unreadable" 是哨兵而非摘要，两次都没读到不等于内容没变，直接判冲突。
        let key = record_key(&record.root, &record.rel_path);
        if let Some(map) = &expected_by_key {
            let current = current_state_hash(&target);
            match map.get(key.as_str()) {
                Some(expected) if current != "unreadable" && current == **expected => {}
                _ => {
                    result.conflicts.push(display);
                    continue;
                }
            }
        }
        if !record.existed_before {
            match fs::symlink_metadata(&target) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    result.clean_files += 1;
                }
                Err(e) => result.failed.push(format!("{display}: {e}")),
                Ok(md) => {
                    if !md.is_file() {
                        result.failed.push(format!("{display}: not a regular file"));
                        continue;
                    }
                    if let Err(e) = reject_multi_hardlink(&md) {
                        result.failed.push(format!("{display}: {e}"));
                        continue;
                    }
                    if let Err(e) = reverify_target(&record, &target, authorized_roots) {
                        result.failed.push(format!("{display}: {e}"));
                        continue;
                    }
                    match fs::remove_file(&target) {
                        Ok(()) => result.deleted_files += 1,
                        Err(e) => result.failed.push(format!("{display}: {e}")),
                    }
                }
            }
            continue;
        }
        let Some(blob) = &record.blob else {
            result.failed.push(format!("{display}: blob missing"));
            continue;
        };
        let blob_path = blobs_dir(dir).join(blob);
        let restore = (|| -> Result<bool, String> {
            let pre_image = fs::read(&blob_path).map_err(|e| e.to_string())?;
            match fs::symlink_metadata(&target) {
                Ok(md) => {
                    if !md.is_file() {
                        return Err("not a regular file".to_string());
                    }
                    reject_multi_hardlink(&md)?;
                    if let Ok(current) = fs::read(&target) {
                        if current == pre_image {
                            let mode_changed = mode_differs(record.mode, &target);
                            restore_file_mode(&target, record.mode);
                            return Ok(mode_changed);
                        }
                    }
                }
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    return Err(e.to_string());
                }
                Err(_) => {}
            }
            reverify_target(&record, &target, authorized_roots)?;
            atomic_write(&target, &pre_image)?;
            restore_file_mode(&target, record.mode);
            Ok(true)
        })();
        match restore {
            Ok(true) => result.restored_files += 1,
            Ok(false) => result.clean_files += 1,
            Err(e) => result.failed.push(format!("{display}: {e}")),
        }
    }
    result
}

/// 锁内的"回退 + 写审计/剪枝标记"。调用方必须已持有 INDEX_LOCK。
fn rewind_and_mark_at(
    dir: &Path,
    turn_seq: u64,
    authorized: &[PathBuf],
    expected: Option<&[CheckpointExpectedEntry]>,
) -> CheckpointRewindResult {
    let result = rewind_at(dir, turn_seq, authorized, expected);
    let complete = rewind_is_complete(&result);
    let marker = CheckpointRecord {
        schema: 2,
        turn_seq: if complete { turn_seq } else { 0 },
        turn_id: String::new(),
        root: String::new(),
        rel_path: String::new(),
        kind: "rewind".to_string(),
        existed_before: false,
        blob: None,
        size: 0,
        mtime_ms: 0,
        captured_at: now_ms(),
        note: Some(format!(
            "target={} restored={} deleted={} conflicts={} failed={} capture_errors={} complete={}",
            turn_seq,
            result.restored_files,
            result.deleted_files,
            result.conflicts.len(),
            result.failed.len(),
            result.capture_errors,
            complete
        )),
        mode: None,
    };
    let _ = append_record(dir, &marker);
    result
}

#[tauri::command]
pub async fn checkpoint_rewind_code(
    conversation_id: String,
    turn_seq: u64,
    authorized_roots: Vec<String>,
    expected: Vec<CheckpointExpectedEntry>,
) -> Result<CheckpointRewindResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = conversation_dir(&conversation_id)?;
        let authorized = canonical_authorized_roots(&authorized_roots);
        // 整段（读索引 → 逐个恢复 → 写标记）持锁：回退期间若有工具捕获落盘，
        // 新记录的 turn_seq 会落在 target 之上，随后写下的剪枝标记会把刚发生
        // 的改动一并当作"陈旧未来"埋掉。
        let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        Ok(rewind_and_mark_at(
            &dir,
            turn_seq,
            &authorized,
            Some(&expected),
        ))
    })
    .await
    .map_err(|e| format!("checkpoint_rewind_code join failed: {e}"))?
}

/// 清理入口：删除整个会话的检查点数据（索引 + blobs）。
#[tauri::command]
pub async fn checkpoint_clear(conversation_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let dir = conversation_dir(&conversation_id)?;
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| format!("checkpoint_clear join failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("reinagent-ckpt-test-{}-{}", name, now_ms()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn capture_and_rewind_restores_pre_image() {
        let ws = temp_dir("ws");
        let dir = temp_dir("ckpt");
        let file = ws.join("a.txt");
        fs::write(&file, "before").unwrap();

        let seq = capture_at(&dir, "turn-1", &ws, Path::new("a.txt"), PreImage::File(None)).unwrap();
        assert_eq!(seq, 1);
        fs::write(&file, "after").unwrap();

        let mut result = rewind_at(&dir, 1, &[dunce::canonicalize(&ws).unwrap()], None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "before");

        // 第二次回退同一路径：内容已等于前像 → clean。
        result = rewind_at(&dir, 1, &[dunce::canonicalize(&ws).unwrap()], None);
        assert_eq!(result.clean_files, 1);
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rewind_deletes_files_created_in_turn() {
        let ws = temp_dir("ws2");
        let dir = temp_dir("ckpt2");
        let file = ws.join("new.txt");
        let seq = capture_at(&dir, "turn-1", &ws, Path::new("new.txt"), PreImage::Missing).unwrap();
        fs::write(&file, "created").unwrap();
        let result = rewind_at(&dir, seq, &[dunce::canonicalize(&ws).unwrap()], None);
        assert_eq!(result.deleted_files, 1);
        assert!(!file.exists());
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rewind_to_later_turn_keeps_earlier_changes() {
        let ws = temp_dir("ws3");
        let dir = temp_dir("ckpt3");
        let a = ws.join("a.txt");
        let b = ws.join("b.txt");
        fs::write(&a, "orig-a").unwrap();
        fs::write(&b, "orig-b").unwrap();
        capture_at(&dir, "turn-1", &ws, Path::new("a.txt"), PreImage::File(None)).unwrap();
        capture_at(&dir, "turn-2", &ws, Path::new("b.txt"), PreImage::File(None)).unwrap();
        fs::write(&a, "after-a").unwrap();
        fs::write(&b, "after-b").unwrap();
        // 只回退 turn-2：turn-1 的改动保持。
        let result = rewind_at(&dir, 2, &[dunce::canonicalize(&ws).unwrap()], None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&a).unwrap(), "after-a");
        assert_eq!(fs::read_to_string(&b).unwrap(), "orig-b");
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_records_prune_stale_future_turns() {
        let dir = temp_dir("ckpt4");
        begin_turn_at(&dir, "t1").unwrap();
        begin_turn_at(&dir, "t2").unwrap();
        let summaries = checkpoint_turn_summaries(read_index(&dir));
        assert_eq!(summaries.len(), 2);
        // 完整回退 turn-2 后写剪枝标记：turn-2 从列表消失。
        let empty: Vec<CheckpointExpectedEntry> = Vec::new();
        let result = rewind_and_mark_at(&dir, 2, &[], Some(&empty));
        assert_eq!(result.turn_seq, 2);
        let summaries = checkpoint_turn_summaries(read_index(&dir));
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].turn_id, "t1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn expected_hash_mismatch_becomes_conflict() {
        let ws = temp_dir("ws4");
        let dir = temp_dir("ckpt5");
        let file = ws.join("a.txt");
        fs::write(&file, "orig").unwrap();
        capture_at(&dir, "t1", &ws, Path::new("a.txt"), PreImage::File(None)).unwrap();
        fs::write(&file, "after").unwrap();
        let authorized = vec![dunce::canonicalize(&ws).unwrap()];
        // 带一个肯定不匹配的期望哈希 → 冲突跳过，不覆盖。
        let expected = vec![CheckpointExpectedEntry {
            key: record_key(&normalize_root(&authorized[0]), "a.txt"),
            current_hash: "deadbeef".to_string(),
        }];
        let result = rewind_at(&dir, 1, &authorized, Some(&expected));
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.restored_files, 0);
        assert_eq!(fs::read_to_string(&file).unwrap(), "after");
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&dir);
    }
}
