//! ~/.ssh/config 解析（⑫）：Host 块（忽略通配符）+ Include 展开，供
//! 「从 SSH 配置导入」表单预填。纯解析零副作用；文件不存在返回空列表。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

fn default_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(Path::new(&home).join(".ssh").join("config"))
}

fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return Path::new(&home).join(rest);
        }
    }
    PathBuf::from(p)
}

/// 解析配置（含 Include 一次展开，防环）；解析失败按无记录处理
pub fn load(config_path: Option<&str>) -> Vec<SshConfigHost> {
    let path = config_path.map(PathBuf::from).or_else(default_path);
    let Some(path) = path else { return Vec::new() };
    let mut hosts = Vec::new();
    let mut visited = HashSet::new();
    parse(&path, &mut hosts, &mut visited, 0);
    hosts
}

fn parse(path: &Path, hosts: &mut Vec<SshConfigHost>, visited: &mut HashSet<PathBuf>, depth: u8) {
    if depth > 3 || !visited.insert(path.to_path_buf()) {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let mut current: Option<SshConfigHost> = None;
    let mut flush = |cur: &mut Option<SshConfigHost>, hosts: &mut Vec<SshConfigHost>| {
        if let Some(h) = cur.take() {
            if !h.alias.contains('*') && !h.alias.contains('?') && !h.alias.is_empty() {
                hosts.push(h);
            }
        }
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(['=', ' ']) {
            Some((k, v)) => (k.trim().to_lowercase(), v.trim()),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                flush(&mut current, hosts);
                current = Some(SshConfigHost {
                    alias: value.to_string(),
                    hostname: None,
                    user: None,
                    port: None,
                    identity_file: None,
                });
            }
            "include" => {
                let base = path.parent().unwrap_or(Path::new("/"));
                for part in value.split_whitespace() {
                    let p = expand_tilde(part);
                    let p = if p.is_absolute() { p } else { base.join(p) };
                    parse(&p, hosts, visited, depth + 1);
                }
            }
            "hostname" => {
                if let Some(h) = current.as_mut() {
                    h.hostname = Some(value.to_string());
                }
            }
            "user" => {
                if let Some(h) = current.as_mut() {
                    h.user = Some(value.to_string());
                }
            }
            "port" => {
                if let Some(h) = current.as_mut() {
                    h.port = value.parse().ok();
                }
            }
            "identityfile" => {
                if let Some(h) = current.as_mut() {
                    h.identity_file = Some(value.to_string());
                }
            }
            _ => {}
        }
    }
    flush(&mut current, hosts);
}

/// Tauri 命令：列出 ~/.ssh/config 主机（导入表单用）
#[tauri::command]
pub async fn ssh_config_list() -> Result<Vec<SshConfigHost>, String> {
    tauri::async_runtime::spawn_blocking(move || load(None)).await.map_err(|e| e.to_string())
}
