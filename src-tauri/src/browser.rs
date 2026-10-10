//! browser.rs —— 内嵌浏览器面板（路线 B'：Tauri unstable 多 webview）。
//!
//! 主窗口内 Window::add_child 创建第二个 WebView（TAURI 处理全部 COM/Controller
//! 细节），bounds 由前端面板上报、Webview::set_bounds 跟随。模型侧不走 CDP：
//! browser_eval 经 Webview::eval 在子 WebView 里执行 JS（快照/填值/点击由工具层
//! 组装脚本）；browser_navigate 走原生 Navigate；browser_current_url 供快照定位。

#[cfg(target_os = "windows")]
use std::sync::Mutex;
#[cfg(target_os = "windows")]
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
    let _ = webview.with_webview(move |platform| {
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
    let _ = WEBMSG_HANDLER_REGISTERED.set(());
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
    // Linux：tauri-runtime-wry 把 WindowChild 塞进主窗口 default_vbox()（GtkBox 顺序
    // 堆叠 → 子 webview 排在主 webview 之下），而 wry 的 set_bounds 仅在 GtkFixed
    // 容器（is_in_fixed_parent）里才真正生效。实际的重挂延迟到首次
    // browser_set_bounds（面板已布局、页面已加载，重挂后立即精确 allocate）。
    // Windows 走原生子 HWND，无需此修复。
    Ok(())
}

/// reparent 是否已完成（Linux；首次 set_bounds 时执行一次，关闭时重置）。
#[cfg(target_os = "linux")]
static BROWSER_REPARENT_DONE: std::sync::Mutex<Option<()>> = std::sync::Mutex::new(None);

/// 把浏览器子 webview 的 GTK 父容器从 VBox 换成 GtkFixed（仅 Linux）。
///
/// 为什么需要：wry 的 `set_bounds` 只在创建时容器为 GtkFixed 才生效
/// （`is_in_fixed_parent` 字段在 add_to_container 时一次性写死，之后 reparent
/// 也不会更新）——而 tauri 在 Linux 一律 `build_gtk(window.default_vbox())`，
/// 于是 set_bounds 恒为空操作，子 webview 被 VBox 顺序堆叠在主 webview 前/后。
///
/// 因此本函数做两件事：① 把 webview 移进新建的 GtkFixed（按原 slot 位置放回）；
/// ② **绕过 wry**，直接在 GTK 层 `size_allocate` 精确落位（见 browser_place_gtk）。
/// 幂等：父容器已是 GtkFixed 时跳过。
#[cfg(target_os = "linux")]
fn reparent_browser_webview_to_fixed(
    window: &tauri::Window<tauri::Wry>,
) -> Result<(), String> {
    let webview = window
        .get_webview(BROWSER_LABEL)
        .ok_or_else(|| "reparent: 浏览器 webview 不存在".to_string())?;
    webview
        .with_webview(move |platform| {
            use gtk::prelude::*;
            let wk = platform.inner();
            let widget: gtk::Widget = wk.clone().upcast::<gtk::Widget>();
            let Some(parent) = widget.parent() else {
                return;
            };
            if parent.type_().name() == "GtkFixed" {
                return; // 已是 Fixed（幂等重入）
            }
            let Some(box_parent) = parent.dynamic_cast_ref::<gtk::Box>() else {
                return;
            };
            // 记录 webview 在 VBox 中的原 slot（仅用于日志）
            let children = box_parent.children();
            let index = children
                .iter()
                .position(|c| c == &widget)
                .unwrap_or(children.len().saturating_sub(1));
            // ★ 关键：Fixed 必须以「叠加层」覆盖整个窗口——实测数据证明，直接把 Fixed
            //   add 到 GtkWindow 会被默认布局流摆到窗口下半区（parent_alloc y=622），
            //   于是 webview 的 y=45 变成窗口绝对 667（跑到下面）。GTK3 的正解是
            //   **GtkOverlay**：把窗口现有的 VBox 作为主 child（继续保持原布局），
            //   Fixed 作为 overlay child 覆盖其上，坐标即窗口绝对坐标。
            let fixed = gtk::Fixed::new();
            fixed.set_hexpand(true);
            fixed.set_vexpand(true);
            box_parent.remove(&widget);

            let overlay = box_parent
                .toplevel()
                .and_then(|t| t.downcast::<gtk::Window>().ok())
                .map(|gtk_win| {
                    // 窗口当前唯一内容 = VBox（box_parent）；抽出后交给 Overlay 当主 child
                    let vbox_widget: gtk::Widget = box_parent.clone().upcast::<gtk::Widget>();
                    if let Some(current) = gtk_win.children().into_iter().next() {
                        gtk_win.remove(&current);
                    }
                    let overlay = gtk::Overlay::new();
                    overlay.add(&vbox_widget);        // 主层：原有 UI（含主 webview）
                    overlay.add_overlay(&fixed);      // 叠加层：浏览器 Fixed（定位坐标 = 窗口绝对）
                    // ★ 穿透：Fixed 的空白区不吞事件，只有 webview 自身那块接收
                    //   （否则覆盖全窗口的叠加层会拦截整个应用的点击——实测症状：
                    //   打开浏览器后对话框/输入框全部点不动）。
                    overlay.set_overlay_pass_through(&fixed, true);
                    gtk_win.add(&overlay);
                    overlay.show_all();
                    gtk_win
                });

            match overlay {
                Some(_) => {
                    // Fixed 尺寸不铺满窗口：随 webview 的实际矩形增长（place 里再精确设定），
                    // 配合 pass-through 保证非 webview 区域完全不影响原 UI 交互。
                    fixed.set_size_request(1, 1);
                    fixed.size_allocate(&gtk::Allocation::new(0, 0, 1, 1));
                }
                None => {
                    box_parent.pack_start(&fixed, true, true, 0);
                    box_parent.reorder_child(&fixed, index as i32);
                    fixed.show_all();
                }
            }
            fixed.put(&widget, 0, 0);
        })
        .map_err(|e| format!("reparent: with_webview 派发失败: {e}"))?;
    Ok(())
}

/// Linux 专用定位：直接在 GTK 层给子 webview 分配矩形（绕过 wry 失效的 set_bounds）。
/// 物理像素 → GTK 逻辑像素（按窗口缩放），`size_request` 保证 Fixed 容器按该尺寸布局。
#[cfg(target_os = "linux")]
fn browser_place_gtk(
    window: &tauri::Window<tauri::Wry>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let webview = window
        .get_webview(BROWSER_LABEL)
        .ok_or_else(|| "browser: 浏览器未打开".to_string())?;
    webview
        .with_webview(move |platform| {
            use gtk::prelude::*;
            let wk = platform.inner();
            let widget: gtk::Widget = wk.clone().upcast::<gtk::Widget>();
            let scale = widget.scale_factor() as f64;
            let lx = (x as f64 / scale).round() as i32;
            let ly = (y as f64 / scale).round() as i32;
            let lw = (width as f64 / scale).round().max(1.0) as i32;
            let lh = (height as f64 / scale).round().max(1.0) as i32;
            widget.set_size_request(lw, lh);
            // ★ GtkFixed 中移动已加入的子控件必须用 move_（gtk_fixed_move）——
            //   put() 只在初次加入时设定位置，之后单独 size_allocate 不会改变
            //   GtkFixed 记录的 child x/y，控件会停在 (0,0)（实测：allocation 正确但画在左上角）。
            if let Some(fixed) = widget
                .parent()
                .and_then(|p| p.downcast::<gtk::Fixed>().ok())
            {
                fixed.move_(&widget, lx, ly);
                // Fixed 自身尺寸跟随 webview 区域（叠加层开启穿透后，非该区域不影响原 UI）
                fixed.set_size_request(lx + lw, ly + lh);
            }
            widget.size_allocate(&gtk::Allocation::new(lx, ly, lw, lh));
        })
        .map_err(|e| format!("browser place: with_webview 派发失败: {e}"))?;
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
    // Linux：首次调用时先做 VBox→GtkFixed 重挂（此时面板已布局、页面已加载，
    // 重挂后立即按本矩形 allocate，避免过早 reparent 导致的空白/位置错乱）。
    #[cfg(target_os = "linux")]
    {
        let already = BROWSER_REPARENT_DONE
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        if !already {
            let window = app
                .get_window("main")
                .ok_or_else(|| "browser: 主窗口不存在".to_string())?;
            reparent_browser_webview_to_fixed(&window)?;
            if let Ok(mut guard) = BROWSER_REPARENT_DONE.lock() {
                *guard = Some(());
            }
        }
    }
    // Linux：wry 的 set_bounds 因 is_in_fixed_parent 恒 false 而失效（见
    // reparent_browser_webview_to_fixed 注释）——改走 GTK 直连定位。
    #[cfg(target_os = "linux")]
    {
        let window = app
            .get_window("main")
            .ok_or_else(|| "browser: 主窗口不存在".to_string())?;
        browser_place_gtk(&window, x, y, width, height)?;
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        let webview = get_browser_webview(&app)?;
        webview
            .set_bounds(tauri::Rect {
                position: tauri::Position::Physical(
                    tauri::PhysicalPosition::new(x, y).into(),
                ),
                size: tauri::Size::Physical(
                    tauri::PhysicalSize::new(width.max(0) as u32, height.max(0) as u32),
                ),
            })
            .map_err(|e| format!("设置浏览器区域失败: {e}"))?;
        Ok(())
    }
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
    // Linux：先撤掉叠加层（GtkOverlay + Fixed），把窗口内容还原为原始 VBox，
    // 避免残留的叠加层继续吞事件或遮挡 UI（webview 关闭后 Fixed 仍在窗口上）。
    #[cfg(target_os = "linux")]
    {
        let win = window.clone();
        if let Some(webview) = window.get_webview(BROWSER_LABEL) {
            let _ = webview.with_webview(move |platform| {
                use gtk::prelude::*;
                let wk = platform.inner();
                let widget: gtk::Widget = wk.clone().upcast::<gtk::Widget>();
                // 从 Fixed 里摘出 webview，再拆掉 Fixed/Overlay，恢复 VBox 为窗口唯一内容
                if let Some(fixed) = widget.parent().and_then(|p| p.downcast::<gtk::Fixed>().ok()) {
                    fixed.remove(&widget);
                    if let Some(overlay) = fixed.parent().and_then(|p| p.downcast::<gtk::Overlay>().ok()) {
                        let vbox = overlay
                            .children()
                            .into_iter()
                            .find(|c| c.type_().name() == "GtkBox");
                        if let Some(ref vbox) = vbox {
                            overlay.remove(vbox);
                        }
                        overlay.remove(&fixed);
                        if let Some(gtk_win) = overlay
                            .toplevel()
                            .and_then(|t| t.downcast::<gtk::Window>().ok())
                        {
                            gtk_win.remove(&overlay);
                            if let Some(vbox) = vbox {
                                gtk_win.add(&vbox);
                                vbox.show_all();
                            }
                        }
                    }
                }
            });
        }
        let _ = win;
    }
    if let Some(webview) = window.get_webview(BROWSER_LABEL) {
        webview
            .close()
            .map_err(|e| format!("关闭浏览器失败: {e}"))?;
    }
    // 下次打开是全新 webview 实例：重置 reparent 标记（首次 set_bounds 重新重挂）。
    #[cfg(target_os = "linux")]
    if let Ok(mut guard) = BROWSER_REPARENT_DONE.lock() {
        *guard = None;
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
    #[cfg(target_os = "linux")]
    {
        // Linux（WebKitGTK）：与 Windows 的 postMessage 槽位不同——evaluate_javascript
        // 的完成回调直接带回 JS 结果值（JSC Value::to_str），无需页面侧上报。
        // with_webview 的闭包由 tauri 派发到事件线程（= GTK 主线程）执行，
        // WebKitGTK API 的 MainContext 断言天然满足。
        // ⚠ evaluate_javascript 不解析 Promise——提取脚本须为同步 IIFE（tools.js 现有脚本均满足）。
        let webview = get_browser_webview(&app)?;
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        let full_js = format!(
            "(function(){{let r;try{{r=eval({js:?});}}catch(e){{r='ERR '+String(e);}}return String(r);}})()"
        );
        webview
            .with_webview(move |platform| {
                let wk = platform.inner();
                use webkit2gtk::WebViewExt;
                wk.evaluate_javascript(
                    &full_js,
                    None::<&str>,
                    None::<&str>,
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |result| {
                        use javascriptcore::ValueExt as _;
                        let out = match result {
                            Ok(v) => v.to_str().to_string(),
                            Err(e) => format!("ERR: {e}"),
                        };
                        let _ = tx.send(Ok(out));
                    },
                );
            })
            .map_err(|e| format!("browser read: with_webview 派发失败: {e}"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err("browser read: 超时（15s，页面可能未响应）".to_string());
            }
            match rx.recv_timeout(remaining) {
                Ok(Ok(text)) => return Ok(text),
                Ok(Err(e)) => return Err(e),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err("browser read: 超时（15s，页面可能未响应）".to_string());
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("browser read: 结果通道关闭（webview 已销毁？）".to_string());
                }
            }
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Err("当前平台内嵌浏览器暂不支持 eval 结果读取".to_string())
    }
}

#[allow(dead_code)] // 保留：字节协议扫描备用工具
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
        let _ = webview.with_webview(move |platform| {
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
    #[cfg(target_os = "linux")]
    {
        // Linux（WebKitGTK）：原生 webkit_web_view_get_snapshot（Visible = 视口，
        // 与 Windows CDP captureScreenshot 口径一致）→ cairo Surface → PNG →
        // data URL（前端 tools.js 兼容 data:image/... 前缀）。
        // with_webview 的闭包由 tauri 派发到事件线程（= GTK 主线程）执行。
        let webview = get_browser_webview(&app)?;
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        webview
            .with_webview(move |platform| {
                let wk = platform.inner();
                use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
                wk.snapshot(
                    SnapshotRegion::Visible,
                    SnapshotOptions::NONE,
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |result| {
                        let out = match result {
                            Ok(surface) => {
                                let mut png: Vec<u8> = Vec::new();
                                match surface.write_to_png(&mut png) {
                                    Ok(()) => {
                                        use base64::Engine as _;
                                        let b64 =
                                            base64::engine::general_purpose::STANDARD.encode(&png);
                                        Ok(format!("data:image/png;base64,{b64}"))
                                    }
                                    Err(e) => Err(format!("PNG 编码失败: {e}")),
                                }
                            }
                            Err(e) => Err(format!("snapshot 失败: {e}")),
                        };
                        let _ = tx.send(out);
                    },
                );
            })
            .map_err(|e| format!("browser screenshot: with_webview 派发失败: {e}"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err("browser screenshot: 超时（20s）".to_string());
            }
            match rx.recv_timeout(remaining) {
                Ok(Ok(data_url)) => return Ok(data_url),
                Ok(Err(e)) => return Err(e),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err("browser screenshot: 超时（20s）".to_string());
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("browser screenshot: 结果通道关闭（webview 已销毁？）".to_string());
                }
            }
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Err("当前平台内嵌浏览器暂不支持原生截图".to_string())
    }
}
