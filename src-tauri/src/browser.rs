//! browser.rs —— 内嵌浏览器面板（路线 B'：Tauri unstable 多 webview）。
//!
//! 主窗口内 Window::add_child 创建第二个 WebView（TAURI 处理全部 COM/Controller
//! 细节），bounds 由前端面板上报、Webview::set_bounds 跟随。模型侧不走 CDP：
//! browser_eval 经 Webview::eval 在子 WebView 里执行 JS（快照/填值/点击由工具层
//! 组装脚本）；browser_navigate 走原生 Navigate；browser_current_url 供快照定位。

use std::io::Write as _;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::command;
use tauri::AppHandle;
use tauri::Manager;
use tauri::Webview;
use tauri::WebviewUrl;

#[cfg(target_os = "windows")]
use windows::core::HSTRING;
#[cfg(target_os = "windows")]
use windows::core::PWSTR;
#[cfg(target_os = "windows")]
use webview2_com::WebMessageReceivedEventHandler;

const BROWSER_LABEL: &str = "browser-pane";

fn get_browser_webview(app: &AppHandle) -> Result<Webview, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "browser: 主窗口不存在".to_string())?;
    window
        .get_webview(BROWSER_LABEL)
        .ok_or_else(|| "浏览器未打开".to_string())
}

fn parse_url(url: &str) -> Result<tauri::Url, String> {
    url.parse()
        .map_err(|e| format!("browser: 无效 URL {url}: {e}"))
}

/// 子 WebView postMessage 上报槽：(时间戳毫秒, 消息)。WebMessageReceived handler 写入。
#[cfg(target_os = "windows")]
static LAST_WEB_MESSAGE: OnceLock<Mutex<Option<(i64, String)>>> = OnceLock::new();
#[cfg(target_os = "windows")]
fn last_web_message_slot() -> &'static Mutex<Option<(i64, String)>> {
    LAST_WEB_MESSAGE.get_or_init(|| Mutex::new(None))
}
#[cfg(target_os = "windows")]
static WEBMSG_HANDLER_REGISTERED: OnceLock<()> = OnceLock::new();

/// 在子 WebView 上注册 WebMessageReceived（一次）。页面经
/// window.chrome.webview.postMessage 上报数据——WebView2 原生通道，不受页面 CSP 约束。
#[cfg(target_os = "windows")]
fn ensure_webmsg_handler(app: &AppHandle) -> Result<(), String> {
    if WEBMSG_HANDLER_REGISTERED.get().is_some() {
        return Ok(());
    }
    let webview = get_browser_webview(app)?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    webview.with_webview(move |platform| {
        let result = (|| {
            let controller = platform.controller();
            let core = unsafe {
                controller
                    .CoreWebView2()
                    .map_err(|e| format!("CoreWebView2: {e}"))?
            };
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut ptr = PWSTR::null();
                if let Err(e) = unsafe { args.TryGetWebMessageAsString(&mut ptr) } {
                    return Err(e);
                }
                let msg = unsafe { take_pwstr(ptr) };
                if let Ok(mut slot) = last_web_message_slot().lock() {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    *slot = Some((now, msg));
                }
                Ok(())
            }));
            unsafe {
                let mut token = 0i64;
                core.add_WebMessageReceived(&handler, &mut token)
                    .map_err(|e| format!("add_WebMessageReceived: {e}"))?;
            }
            Ok(())
        })();
        let _ = tx.send(result);
    });
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "browser: 注册消息通道超时".to_string())??;
    WEBMSG_HANDLER_REGISTERED.set(());
    Ok(())
}

#[cfg(target_os = "windows")]
unsafe fn take_pwstr(ptr: PWSTR) -> String {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt as _;
    let mut len = 0usize;
    while *(ptr.0.add(len)) != 0 {
        len += 1;
    }
    let s = OsString::from_wide(std::slice::from_raw_parts(ptr.0, len)).to_string_lossy().to_string();
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(ptr.0 as _)) };
    s
}

#[command]
pub async fn browser_open(app: AppHandle, url: String) -> Result<(), String> {
    // add_child 在 Window 上（WebviewWindow 未转发 unstable 方法）
    let window = app
        .get_window("main")
        .ok_or_else(|| "browser: 主窗口不存在".to_string())?;
    if let Some(webview) = window.get_webview(BROWSER_LABEL) {
        webview
            .navigate(parse_url(&url)?)
            .map_err(|e| format!("browser navigate: {e}"))?;
        return Ok(());
    }
    let builder = tauri::webview::WebviewBuilder::new(BROWSER_LABEL, WebviewUrl::External(parse_url(&url)?));
    if let Err(e) = window.add_child(
        builder,
        tauri::PhysicalPosition::new(0, 0),
        tauri::PhysicalSize::new(100, 100),
    ) {
        // 并发/StrictMode 双开竞态：label 已存在时退化为导航（不吞错——其它错误照报）
        let msg = format!("{e}");
        if !msg.contains("already exists") {
            return Err(format!("创建内嵌浏览器失败: {msg}"));
        }
        let webview = window
            .get_webview(BROWSER_LABEL)
            .ok_or_else(|| format!("浏览器状态异常: {msg}"))?;
        webview
            .navigate(parse_url(&url)?)
            .map_err(|e| format!("browser navigate: {e}"))?;
    }
    Ok(())
}

#[command]
pub async fn browser_set_bounds(
    app: AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let webview = get_browser_webview(&app)?;
    webview
        .set_bounds(tauri_runtime::dpi::Rect {
            position: tauri_runtime::dpi::Position::Physical(
                tauri::PhysicalPosition::new(x, y).into(),
            ),
            size: tauri_runtime::dpi::Size::Physical(
                tauri::PhysicalSize::new(width.max(0) as u32, height.max(0) as u32),
            ),
        })
        .map_err(|e| format!("设置浏览器区域失败: {e}"))?;
    Ok(())
}

#[command]
pub async fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let webview = get_browser_webview(&app)?;
    webview
        .navigate(parse_url(&url)?)
        .map_err(|e| format!("browser navigate: {e}"))?;
    Ok(())
}

/// 在子 WebView 里执行 JS（eval 单向；取值场景由工具层约定 DOM 槽位回读）。
#[command]
pub async fn browser_eval(app: AppHandle, js: String) -> Result<(), String> {
    let webview = get_browser_webview(&app)?;
    webview.eval(js).map_err(|e| format!("browser eval: {e}"))?;
    Ok(())
}

/// 读取子 WebView 当前 URL（快照工具的定位信息）。
#[command]
pub async fn browser_current_url(app: AppHandle) -> Result<String, String> {
    let webview = get_browser_webview(&app)?;
    Ok(webview
        .url()
        .map_err(|e| format!("browser url: {e}"))?
        .to_string())
}

#[command]
pub async fn browser_close(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "browser: 主窗口不存在".to_string())?;
    if let Some(webview) = window.get_webview(BROWSER_LABEL) {
        webview
            .close()
            .map_err(|e| format!("关闭浏览器失败: {e}"))?;
    }
    Ok(())
}

#[command]
pub fn browser_is_open(app: AppHandle) -> bool {
    app.get_window("main")
        .map(|w| w.get_webview(BROWSER_LABEL).is_some())
        .unwrap_or(false)
}


/// 读通道：eval 注入「执行 js → window.chrome.webview.postMessage 上报」，
/// WebMessageReceived handler 收进静态槽。postMessage 是 WebView2 原生通道，
/// 不受页面 CSP/混合内容约束（HTTP fetch 回读会被 bing 等 CSP 拦截——已废弃）。
#[command]
pub async fn browser_read_page(app: AppHandle, js: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let webview = get_browser_webview(&app)?;
        ensure_webmsg_handler(&app)?;
        let slot = last_web_message_slot();
        let start = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        {
            let mut guard = slot.lock().map_err(|e| format!("browser lock: {e}"))?;
            *guard = None;
        }
        let full_js = format!(
            "(async()=>{{let r;try{{r=await eval({js:?});}}catch(e){{r='ERR '+String(e);}}window.chrome.webview.postMessage(String(r));}})()",
        );
        webview
            .eval(full_js)
            .map_err(|e| format!("browser read eval: {e}"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            {
                let guard = slot.lock().map_err(|e| format!("browser lock: {e}"))?;
                if let Some((ts, msg)) = guard.as_ref() {
                    if *ts >= start {
                        return Ok(msg.clone());
                    }
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err("browser read: 超时（15s，页面可能未响应）".to_string());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, js);
        Err("内嵌浏览器仅支持 Windows（WebView2）".to_string())
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}


/// 截图：经 with_webview 拿到底层 Controller，走 CDP Page.captureScreenshot。
/// 返回 base64 JPEG（quality 60）。需要 unstable 特性（PlatformWebview.controller）。
#[command]
pub async fn browser_screenshot(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let webview = get_browser_webview(&app)?;
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        webview.with_webview(move |platform| {
            let result = (|| {
                // PlatformWebview.controller() 在 windows 下直接返回带类型的接口
                let controller = platform.controller();
                let core = unsafe {
                    controller
                        .CoreWebView2()
                        .map_err(|e| format!("CoreWebView2: {e}"))?
                };
                let (ctx, crx) = std::sync::mpsc::channel();
                let handler = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |error_code, return_json: String| {
                        let result: Result<String, String> = (|| {
                            error_code.map_err(|e| format!("CDP 错误: {e}"))?;
                            Ok(return_json)
                        })();
                        let _ = ctx.send(result);
                        Ok(())
                    },
                ));
                unsafe {
                    core.CallDevToolsProtocolMethod(
                        &HSTRING::from("Page.captureScreenshot"),
                        &HSTRING::from(r#"{"format":"jpeg","quality":60}"#),
                        &handler,
                    )
                    .map_err(|e| format!("CDP 调用失败: {e}"))?;
                }
                let json = webview2_com::wait_with_pump(crx)
                    .map_err(|e| format!("等待截图失败: {e}"))??;
                let v: serde_json::Value =
                    serde_json::from_str(&json).map_err(|e| format!("截图 JSON 解析失败: {e}"))?;
                v.get("data")
                    .and_then(|d| d.as_str())
                    .map(|s| s.to_string())
                    .ok_or_else(|| "截图中无 data 字段".to_string())
            })();
            let _ = tx.send(result);
        });
        rx.recv_timeout(Duration::from_secs(20))
            .map_err(|_| "browser screenshot: 超时（20s）".to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("内嵌浏览器仅支持 Windows（WebView2）".to_string())
    }
}
