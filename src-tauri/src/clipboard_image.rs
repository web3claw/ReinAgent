//! clipboard_image.rs —— 原生读剪贴板图片（Linux 兜底）。
//!
//! 背景：Tauri 在 Linux 走 WebKitGTK，`paste` 事件会派发但**不交付剪贴板图片**——
//! `clipboardData` 的 types/files/items 全空（实测），前端拿不到 File。因此绕开 DOM，
//! 照 ZCode CLI 的 Linux 实现（`apps/zcode-cli/packages/cli/src/clipboard-image.ts`）
//! 依次尝试 `wl-paste`（Wayland）与 `xclip`（X11/XWayland），首个成功者胜出。
//!
//! 语义（No-Fallback）：
//! - 拿到图片 → `Ok(Some(..))`（base64 交给前端合成 File，复用既有粘贴落盘链路）；
//! - 剪贴板里确实没有图片 → `Ok(None)`（正常情况，静默）；
//! - 两个工具都不存在 / 图片超过上限 / 读取失败 → `Err(真实原因)`，由前端如实提示；
//! - 非 Linux：WebView 的 paste 事件本来就交付图片文件，无需兜底 → `Ok(None)`。
//!
//! 测试说明：只做无副作用单测。**刻意不写「往剪贴板放图再读回」的 E2E 用例**——
//! `xclip -i` 会 fork 成后台守护进程接管剪贴板（劫持用户剪贴板，且继承测试进程的
//! 输出管道会让测试框架一直等它），代价大于收益。读取链路本身已在真机探针中验证过：
//! `xclip -t TARGETS -o` 列出 image/png、`xclip -t image/png -o` 取回真实 PNG 字节。

use serde::Serialize;

/// 与发送链路一致的内联上限（`fs_cmd::ATTACHMENT_INLINE_MAX_BYTES`）。
// 仅 Linux 读取路径使用：不加 cfg 门的话，非 Linux 构建会报 never used 警告。
#[cfg(target_os = "linux")]
const MAX_CLIPBOARD_IMAGE_BYTES: usize = 25 * 1024 * 1024;

/// 剪贴板读取候选：(可执行文件, 参数, mime, 扩展名)——先 Wayland 后 X11，与 ZCode 同序同集合。
#[cfg(target_os = "linux")]
const CLIPBOARD_IMAGE_CANDIDATES: [(&str, &[&str], &str, &str); 8] = [
    ("wl-paste", &["--type", "image/png"], "image/png", "png"),
    ("wl-paste", &["--type", "image/jpeg"], "image/jpeg", "jpg"),
    ("wl-paste", &["--type", "image/gif"], "image/gif", "gif"),
    ("wl-paste", &["--type", "image/webp"], "image/webp", "webp"),
    (
        "xclip",
        &["-selection", "clipboard", "-t", "image/png", "-o"],
        "image/png",
        "png",
    ),
    (
        "xclip",
        &["-selection", "clipboard", "-t", "image/jpeg", "-o"],
        "image/jpeg",
        "jpg",
    ),
    (
        "xclip",
        &["-selection", "clipboard", "-t", "image/gif", "-o"],
        "image/gif",
        "gif",
    ),
    (
        "xclip",
        &["-selection", "clipboard", "-t", "image/webp", "-o"],
        "image/webp",
        "webp",
    ),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImage {
    /// 例如 "image/png"
    pub mime: String,
    /// 建议文件名（前端合成 File 用；落盘时 Rust 侧还会加时间戳前缀并消毒）
    pub name: String,
    /// 不带 data URL 前缀的裸 base64
    pub base64_data: String,
}

#[tauri::command]
pub async fn clipboard_read_image() -> Result<Option<ClipboardImage>, String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(read_clipboard_image_sync)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(None)
    }
}

#[cfg(target_os = "linux")]
fn read_clipboard_image_sync() -> Result<Option<ClipboardImage>, String> {
    let mut tool_available = false;
    for (bin, args, mime, ext) in CLIPBOARD_IMAGE_CANDIDATES {
        if !command_exists(bin) {
            continue;
        }
        tool_available = true;
        let Some(output) = run_candidate(bin, args) else {
            continue;
        };
        if !output.status.success() || output.stdout.is_empty() {
            // 该 target 不可用（例如剪贴板只有 png 时的 image/jpeg 请求）→ 试下一个
            continue;
        }
        if output.stdout.len() > MAX_CLIPBOARD_IMAGE_BYTES {
            return Err(format!(
                "剪贴板图片过大：{} 字节（上限 {} 字节）",
                output.stdout.len(),
                MAX_CLIPBOARD_IMAGE_BYTES
            ));
        }
        use base64::Engine as _;
        return Ok(Some(ClipboardImage {
            mime: mime.to_string(),
            name: format!("clipboard.{ext}"),
            base64_data: base64::engine::general_purpose::STANDARD.encode(&output.stdout),
        }));
    }

    if !tool_available {
        return Err(
            "未找到 wl-paste 或 xclip，无法读取剪贴板图片；请安装其一（例如 sudo apt install xclip）后重试"
                .to_string(),
        );
    }
    // 工具在、但剪贴板里没有图片：正常情况（文本/空剪贴板）
    Ok(None)
}

/// 包一层 coreutils `timeout`，避免剪贴板 owner 不响应时长期挂起；`timeout` 缺失则直接跑。
#[cfg(target_os = "linux")]
fn run_candidate(bin: &str, args: &[&str]) -> Option<std::process::Output> {
    use std::process::Command;
    match Command::new("timeout").arg("5").arg(bin).args(args).output() {
        Ok(output) => Some(output),
        Err(_) => Command::new(bin).args(args).output().ok(),
    }
}

/// 按 PATH 判断可执行文件是否存在（不额外依赖 which）。
#[cfg(target_os = "linux")]
fn command_exists(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(bin).is_file()))
        .unwrap_or(false)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    /// 候选表契约：Wayland 优先于 X11，且两种工具都覆盖 png/jpeg/gif/webp，
    /// mime 与扩展名一一对应（改表时别把顺序或格式漏掉）。
    #[test]
    fn clipboard_candidates_cover_both_tools_and_formats_wayland_first() {
        let bins: Vec<&str> = CLIPBOARD_IMAGE_CANDIDATES.iter().map(|c| c.0).collect();
        let first_xclip = bins.iter().position(|b| *b == "xclip").expect("应有 xclip 候选");
        let last_wl = bins.iter().rposition(|b| *b == "wl-paste").expect("应有 wl-paste 候选");
        assert!(last_wl < first_xclip, "wl-paste 候选必须排在 xclip 之前");

        for bin in ["wl-paste", "xclip"] {
            let mimes: Vec<&str> = CLIPBOARD_IMAGE_CANDIDATES
                .iter()
                .filter(|c| c.0 == bin)
                .map(|c| c.2)
                .collect();
            assert_eq!(
                mimes,
                vec!["image/png", "image/jpeg", "image/gif", "image/webp"],
                "{bin} 的格式集合与顺序"
            );
        }

        for (_, _, mime, ext) in CLIPBOARD_IMAGE_CANDIDATES {
            let expected = match mime {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "image/gif" => "gif",
                "image/webp" => "webp",
                other => panic!("未预期的 mime: {other}"),
            };
            assert_eq!(ext, expected, "mime/扩展名需一一对应");
        }
    }

    #[test]
    fn command_exists_finds_real_binary_and_rejects_missing_one() {
        assert!(command_exists("sh"), "sh 应在 PATH 中");
        assert!(
            !command_exists("reinagent-definitely-missing-binary"),
            "不存在的可执行文件必须返回 false"
        );
    }
}
