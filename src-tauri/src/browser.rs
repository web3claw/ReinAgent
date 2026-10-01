//! browser.rs —— 内嵌浏览器面板（路线 B'：Tauri unstable 多 webview）。
//!
//! 主窗口内 Window::add_child 创建第二个 WebView（TAURI 处理全部 COM/Controller
//! 细节），bounds 由前端面板上报、Webview::set_bounds 跟随。模型侧不走 CDP：
//! browser_eval 经 Webview::eval 在子 WebView 里执行 JS（快照/填值/点击由工具层
//! 组装脚本）；browser_navigate 走原生 Navigate；browser_current_url 供快照定位。

use std::io::Write as _;
use std::time::Duration;
use tauri::command;
use tauri::AppHandle;
use tauri::Manager;
use tauri::Webview;
use tauri::WebviewUrl;

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


/// 读通道：一次性本地 HTTP 监听 + eval 注入「执行 js 并 fetch 上报结果」。
/// 页面为 HTTPS 时 localhost 属可信源（非混合内容），no-cors POST 可达。
#[command]
pub async fn browser_read_page(app: AppHandle, js: String) -> Result<String, String> {
    let webview = get_browser_webview(&app)?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("browser read: bind 失败: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("browser read: addr: {e}"))?
        .port();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // 接受一个连接，读 header 定位 Content-Length，再读 body
        let (mut stream, _) = match listener.accept() {
            Ok(v) => v,
            Err(_) => return,
        };
        use std::io::Read as _;
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        let mut header_end = buf.len();
        loop {
            match stream.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = find_subslice(&buf, b"

") {
                        header_end = pos + 4;
                        break;
                    }
                }
                Err(_) => return,
            }
        }
        let head = String::from_utf8_lossy(&buf[..header_end.min(buf.len())]).to_string();
        let content_length = head
            .to_ascii_lowercase()
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        while buf.len() < header_end + content_length {
            match stream.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                Err(_) => break,
            }
        }
        let body = String::from_utf8_lossy(&buf[header_end.min(buf.len())..]).to_string();
        let _ = stream.write_all(b"HTTP/1.1 204 No Content
Connection: close

");
        let _ = tx.send(body);
    });
    let full_js = format!(
        "(async()=>{{let r;try{{r=await eval({js:?});}}catch(e){{r='ERR '+String(e);}}try{{await fetch('http://127.0.0.1:{port}/s',{{method:'POST',mode:'no-cors',body:String(r)}});}}catch(e){{}}}})()",
    );
    webview
        .eval(full_js)
        .map_err(|e| format!("browser read eval: {e}"))?;
    rx.recv_timeout(Duration::from_secs(15))
        .map_err(|_| "browser read: 超时（15s，页面可能未响应）".to_string())
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
