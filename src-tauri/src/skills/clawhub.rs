//! ClawHub 注册表集成：下载 URL 构建与安装。
//!
//! 本项目商店的搜索 / 列表 / 详情由前端经 `hub_fetch_json`（crate::hub_http）
//! 直连 ClawHub API，Rust 侧仅保留安装链路：slug → 下载 URL → 复用 install 流程。

use serde_json::Value;
use std::path::Path;

use super::*;

const CLAWHUB_API_BASE: &str = "https://clawhub.ai";

pub(crate) fn clawhub_download_url_for_slug(
    slug: &str,
    owner_handle: Option<&str>,
    tag: Option<&str>,
) -> Result<String, String> {
    let slug = slug.trim();
    if slug.is_empty() {
        return Err("SkillsManager clawhub_install requires slug".to_string());
    }
    let tag = tag
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("latest");
    let mut url = format!(
        "{CLAWHUB_API_BASE}/api/v1/download?slug={}&tag={}",
        percent_encode_query_value(slug),
        percent_encode_query_value(tag),
    );
    // ClawHub 对重名 slug 返回 409，必须带 ownerHandle 消歧。
    if let Some(owner) = owner_handle
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        url.push_str(&format!(
            "&ownerHandle={}",
            percent_encode_query_value(owner)
        ));
    }
    Ok(url)
}

pub(crate) fn install_clawhub_skill_from_payload(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
) -> Result<(Vec<SystemSkillInstallResult>, String, String), String> {
    let slug = object_string(payload, "slug")
        .ok_or_else(|| "SkillsManager clawhub_install requires slug".to_string())?
        .to_string();
    let owner_handle =
        object_string(payload, "ownerHandle").or_else(|| object_string(payload, "owner"));
    let version = object_string(payload, "version");
    let download_url = clawhub_download_url_for_slug(&slug, owner_handle, version)?;
    let mut install_payload = payload.clone();
    install_payload.insert("action".to_string(), Value::String("install".to_string()));
    install_payload.insert("source".to_string(), Value::String(download_url.clone()));
    install_payload.insert("slug".to_string(), Value::String(slug.clone()));

    let installed = install_source_from_payload(root, &install_payload)?;
    Ok((installed, slug, download_url))
}
