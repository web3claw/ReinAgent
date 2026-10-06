//! 导入管线的只读外部数据访问（会话导入扩展批次专用）。
//!
//! `import_sqlite_query`：外部工具（ZCode/Cursor/Copilot/Hermes/OpenClaw/Devin）
//! 的会话库是各家私有 SQLite，导入只读不写。打开约定照 Wake `sqlite_ro.rs`：
//! READ_ONLY 直开 + 探测查询验证 → 失败降级「copy 库文件三件套到临时目录再只读
//! 打开」→ 仍失败如实报错。绝不写、绝不 immutable=1（WAL 并发写下不安全）。
//! 只放行单条 SELECT / PRAGMA（防误写）；`spawn_blocking` 隔离，防止大库
//! 首次加载卡死主线程。路径解析复用 fs_cmd 的语义（绝对路径原样、相对路径
//! 挂默认工作区）。
//!
//! `import_read_text_auto`：dsh 会话日志读取——默认落盘是 zstd 多帧连接
//! （首帧 header 行、每次 append 一帧），按 `.zstd` 后缀透明解码到 EOF；
//! 其余按普通 UTF-8 文本读。解压上限 64MB（防 zip-bomb 式膨胀）。

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use rusqlite::OpenFlags;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct ImportSqliteResult {
    pub columns: Vec<String>,
    /// 每行按 columns 顺序对齐的值数组（紧凑；Blob 以 base64 字符串承载）。
    pub rows: Vec<Vec<Value>>,
}

fn resolve_path(raw_path: &str) -> PathBuf {
    let p = Path::new(raw_path);
    if p.is_absolute() {
        p.to_path_buf()
    } else if let Ok(home) = std::env::var("HOME") {
        Path::new(&home).join(".ReinAgent").join(p)
    } else if let Ok(profile) = std::env::var("USERPROFILE") {
        Path::new(&profile).join(".ReinAgent").join(p)
    } else {
        PathBuf::from("/tmp/ReinAgent").join(p)
    }
}

/// JSON 参数 → rusqlite 绑定值。Number 整数绑 i64、小数绑 f64，Bool 转整型。
fn json_to_sql(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(b) => rusqlite::types::Value::Integer(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                rusqlite::types::Value::Integer(i)
            } else {
                rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

fn sql_value_to_json(value: rusqlite::types::Value) -> Value {
    match value {
        rusqlite::types::Value::Null => Value::Null,
        rusqlite::types::Value::Integer(i) => Value::from(i),
        rusqlite::types::Value::Real(f) => Value::from(f),
        rusqlite::types::Value::Text(s) => Value::from(s),
        rusqlite::types::Value::Blob(b) => Value::from(BASE64_STANDARD.encode(&b)),
    }
}

/// 临时目录守卫：drop 时清理整个目录（copy 降级路径的伴生文件）。
struct TempDbGuard(PathBuf);
impl Drop for TempDbGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn open_read_only(db: &Path) -> Result<(rusqlite::Connection, Option<TempDbGuard>), String> {
    if !db.is_file() {
        return Err(format!("not a file: {}", db.display()));
    }
    if let Ok(conn) = rusqlite::Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        let probe: rusqlite::Result<i64> = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0));
        if probe.is_ok() {
            return Ok((conn, None));
        }
    }
    // 只读直开失败（库被独占写锁 / WAL 残缺等）→ copy 三件套到临时目录再开。
    // 目录名带库路径哈希：同一库的两次并发查询不共用目录，互不抽脚。
    let path_hash = {
        use std::hash::{Hash, Hasher as _};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        db.hash(&mut h);
        h.finish()
    };
    let tmp = std::env::temp_dir().join(format!(
        "reinagent-import-{}-{path_hash:016x}",
        std::process::id()
    ));
    fs::create_dir_all(&tmp).map_err(|e| format!("copy staging failed: {e}"))?;
    let guard = TempDbGuard(tmp.clone());
    let db_copy = tmp.join("db.sqlite");
    fs::copy(db, &db_copy).map_err(|e| format!("copy failed: {e}"))?;
    for suffix in ["-wal", "-shm"] {
        let src = PathBuf::from(format!("{}{suffix}", db.display()));
        if src.is_file() {
            let _ = fs::copy(&src, tmp.join(format!("db.sqlite{suffix}")));
        }
    }
    let conn = rusqlite::Connection::open_with_flags(&db_copy, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("copy reopen failed: {e}"))?;
    Ok((conn, Some(guard)))
}

/// 对外部工具的 SQLite 库执行单条只读查询。
/// `path` 为库文件绝对路径；`sql` 必须以 SELECT 或 PRAGMA 开头（大小写不敏感）；
/// `params` 可选位置绑定参数。返回列名与按列对齐的行数组。
#[tauri::command]
pub async fn import_sqlite_query(
    path: String,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<ImportSqliteResult, String> {
    let trimmed = sql.trim().to_string();
    let head = trimmed.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
    if head != "SELECT" && head != "PRAGMA" && head != "WITH" {
        return Err(format!("only SELECT/PRAGMA/WITH queries are allowed, got: {head}"));
    }
    if !trimmed.ends_with(';') {
        // 拒绝多语句（分号结尾的裸查询按单语句放行）。
        if trimmed.contains(';') {
            return Err("multiple statements are not allowed".into());
        }
    } else if trimmed[..trimmed.len() - 1].contains(';') {
        return Err("multiple statements are not allowed".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_path(&path);
        let (conn, _guard) = open_read_only(&resolved)?;
        let bindings: Vec<rusqlite::types::Value> = params
            .unwrap_or_default()
            .iter()
            .map(json_to_sql)
            .collect();
        let mut stmt = conn.prepare(&trimmed).map_err(|e| format!("prepare failed: {e}"))?;
        let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let column_count = columns.len();
        let mut rows_out: Vec<Vec<Value>> = Vec::new();
        let mut rows = stmt
            .query(rusqlite::params_from_iter(bindings.iter()))
            .map_err(|e| format!("query failed: {e}"))?;
        while let Some(row) = rows.next().map_err(|e| format!("row failed: {e}"))? {
            let mut out_row = Vec::with_capacity(column_count);
            for i in 0..column_count {
                let value: rusqlite::types::Value = row.get(i).map_err(|e| format!("column {i} failed: {e}"))?;
                out_row.push(sql_value_to_json(value));
            }
            rows_out.push(out_row);
        }
        Ok(ImportSqliteResult { columns, rows: rows_out })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 同步核心（可单测）：`.zstd` 后缀透明解压（zstd 多帧连接，解到 EOF）；
/// 其余按普通 UTF-8 文本读。dsh 会话日志用（默认落盘即 zstd）。解压上限 64MB。
fn read_text_auto_sync(resolved: &Path) -> Result<String, String> {
    let is_zstd = resolved.extension().is_some_and(|e| e == "zstd");
    if !is_zstd {
        return fs::read_to_string(resolved)
            .map_err(|e| format!("Failed to read {}: {}", resolved.display(), e));
    }
    let file = fs::File::open(resolved)
        .map_err(|e| format!("Failed to open {}: {}", resolved.display(), e))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|e| format!("zstd decoder init failed: {e}"))?;
    let mut out: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 65536];
    let mut reader = decoder;
    loop {
        let n = std::io::Read::read(&mut reader, &mut chunk)
            .map_err(|e| format!("zstd decode failed: {e}"))?;
        if n == 0 {
            break;
        }
        if out.len() + n > 64 * 1024 * 1024 {
            return Err(format!("decompressed log exceeds 64MB: {}", resolved.display()));
        }
        out.extend_from_slice(&chunk[..n]);
    }
    String::from_utf8(out).map_err(|e| format!("log is not valid UTF-8: {e}"))
}

/// 读取文本文件；`.zstd` 后缀透明解压（多帧连接解到 EOF）。dsh 会话日志用。
#[tauri::command]
pub async fn import_read_text_auto(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_path(&path);
        read_text_auto_sync(&resolved)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_text_auto_plain_file() {
        let dir = std::env::temp_dir().join(format!("reinagent-import-plain-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("plain.jsonl");
        fs::write(&path, "{\"type\":\"session\"}\n").unwrap();
        let out = read_text_auto_sync(&path).unwrap();
        assert_eq!(out, "{\"type\":\"session\"}\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_text_auto_zstd_multiframe() {
        // dsh 落盘形态：每次 append 一个 zstd 帧，帧首尾拼接成多帧连接文件。
        let dir = std::env::temp_dir().join(format!("reinagent-import-zstd-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.v4.jsonl.zstd");
        let frame1 = zstd::stream::encode_all(b"{\"type\":\"session\"}\n".as_slice(), 3).unwrap();
        let frame2 = zstd::stream::encode_all(b"{\"type\":\"user/message\"}\n".as_slice(), 3).unwrap();
        let mut blob = frame1;
        blob.extend_from_slice(&frame2);
        fs::write(&path, &blob).unwrap();
        let out = read_text_auto_sync(&path).unwrap();
        assert_eq!(out, "{\"type\":\"session\"}\n{\"type\":\"user/message\"}\n");
        let _ = fs::remove_dir_all(&dir);
    }
}
