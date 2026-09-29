//! 自动更新器（P2-G2）：tauri-plugin-updater 封装。
//!
//! 更新源不在构建期写死——由前端配置后传入本命令（每端点语义 = 静态 latest JSON）。
//! 未配置/检查失败/签名校验失败全部如实上抛，绝不伪装成功（No-Fallback）。

use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    /// 是否配置了更新源（未配置时其余字段无意义）
    pub configured: bool,
    pub has_update: bool,
    pub current_version: String,
    pub available_version: Option<String>,
    pub notes: Option<String>,
    /// 发布日期（RFC3339，源 JSON 原样）
    pub pub_date: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct UpdateEndpointArgs {
    /// 静态 latest JSON 的 URL（https；http 属不安全传输，插件默认拒绝）
    pub endpoint: Option<String>,
}

fn endpoint_of(args: &UpdateEndpointArgs) -> Option<String> {
    args.endpoint
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    args: UpdateEndpointArgs,
) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let Some(endpoint) = endpoint_of(&args) else {
        return Ok(UpdateCheckResult {
            configured: false,
            has_update: false,
            current_version,
            ..Default::default()
        });
    };
    let url = endpoint
        .parse()
        .map_err(|e| format!("更新源 URL 无效：{e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("更新源配置失败：{e}"))?
        .build()
        .map_err(|e| format!("更新器构建失败：{e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败：{e}"))?;
    Ok(match update {
            Some(update) => UpdateCheckResult {
                configured: true,
                has_update: true,
                current_version: update.current_version.clone(),
                available_version: Some(update.version.clone()),
                notes: update.body.clone(),
                pub_date: update
                    .date
                    .map(|d| format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())),
            },
        None => UpdateCheckResult {
            configured: true,
            has_update: false,
            current_version,
            ..Default::default()
        },
    })
}

/// 下载并安装更新（内部重新检查后安装；成功即重启应用）。
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, args: UpdateEndpointArgs) -> Result<(), String> {
    let Some(endpoint) = endpoint_of(&args) else {
        return Err("未配置更新源".to_string());
    };
    let url = endpoint
        .parse()
        .map_err(|e| format!("更新源 URL 无效：{e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("更新源配置失败：{e}"))?
        .build()
        .map_err(|e| format!("更新器构建失败：{e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败：{e}"))?
        .ok_or_else(|| "远端没有可用更新".to_string())?;
    update
        .download_and_install(|_, _| (), || ())
        .await
        .map_err(|e| format!("更新安装失败：{e}"))?;
    // 安装成功 → 重启进新版本（不返回）
    app.restart();
    #[allow(unreachable_code)]
    Ok(())
}
