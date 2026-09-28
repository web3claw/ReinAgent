//! 通用工具：临时目录、时间戳、SkillsManager payload 字段读取与轻量 URL 解析。
//!
//! 轻量 URL 工具替代 LiveAgent 侧对 `reqwest::Url` 的依赖（本项目无 reqwest，
//! 仅需 scheme/host/path/query 的最小解析能力）。

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub(crate) fn new(prefix: &str) -> Result<Self, String> {
        let base = std::env::temp_dir();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = base.join(format!("{prefix}-{}-{now}", std::process::id()));
        fs::create_dir_all(&path)
            .map_err(|e| format!("Failed to create temporary directory: {e}"))?;
        Ok(Self { path })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub(crate) fn strip_utf8_bom(input: &str) -> &str {
    input.strip_prefix('\u{feff}').unwrap_or(input)
}

pub(crate) fn object_string<'a>(
    payload: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(crate) fn object_usize(payload: &serde_json::Map<String, Value>, key: &str) -> Option<usize> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

/// `reqwest::Url` 的最小替代：仅解析 scheme / host / path / query。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SimpleUrl {
    pub(crate) scheme: String,
    /// 小写化的 host（不含端口与 userinfo）。
    pub(crate) host: String,
    /// 始终以 `/` 开头；空路径归一为 `/`。
    pub(crate) path: String,
    pub(crate) query: Option<String>,
}

impl SimpleUrl {
    /// 按 URL 出现顺序返回解码后的 query 键值对（`+` 视为空格，等价 form 编码）。
    pub(crate) fn query_pairs(&self) -> Vec<(String, String)> {
        let Some(query) = self.query.as_deref() else {
            return Vec::new();
        };
        query
            .split('&')
            .filter(|part| !part.is_empty())
            .map(|part| match part.split_once('=') {
                Some((key, value)) => (percent_decode(key), percent_decode(value)),
                None => (percent_decode(part), String::new()),
            })
            .collect()
    }

    /// 非空路径段（按 `/` 切分）。
    pub(crate) fn path_segments(&self) -> Vec<&str> {
        self.path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect()
    }
}

pub(crate) fn parse_simple_url(value: &str) -> Option<SimpleUrl> {
    let value = value.trim();
    let (scheme, rest) = value.split_once("://")?;
    if scheme.is_empty() {
        return None;
    }
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }

    let split_index = rest
        .find(['/', '?', '#'])
        .unwrap_or(rest.len());
    let authority = &rest[..split_index];
    let path_query = rest[split_index..]
        .split('#')
        .next()
        .unwrap_or_default();
    let (path, query) = match path_query.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (path_query, None),
    };

    // 去掉 userinfo（`user:pass@host` 形态取最后一个 @ 之后的部分）。
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let (host, _port) = match host_port.rsplit_once(':') {
        // 仅把纯数字尾段视为端口（不处理 IPv6 字面量，本项目 URL 场景不涉及）。
        Some((host, port)) if !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) => {
            (host, Some(port))
        }
        _ => (host_port, None),
    };
    if host.is_empty() {
        return None;
    }

    Some(SimpleUrl {
        scheme,
        host: host.to_ascii_lowercase(),
        path: if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        },
        query: query
            .filter(|query| !query.is_empty())
            .map(ToString::to_string),
    })
}

/// 解码 `%XX` 转义并把 `+` 还原为空格（form 编码语义，与 reqwest query_pairs 一致）。
pub(crate) fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hi = (bytes[index + 1] as char).to_digit(16);
                let lo = (bytes[index + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi * 16 + lo) as u8);
                    index += 3;
                } else {
                    out.push(b'%');
                    index += 1;
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// query 值的最小百分号编码：保留 unreserved 字符（RFC 3986），空格编码为 `%20`。
pub(crate) fn percent_encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
