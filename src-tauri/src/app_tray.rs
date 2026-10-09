//! 系统托盘（P2-G2）：托盘图标 + 菜单（显示主窗口 / 退出）+ 平台差异化交互。
//! - Linux：左键显示菜单，菜单项恢复窗口（libayatana-appindicator 不支持自定义点击事件）
//! - Windows/macOS：左键切换窗口显隐，右键显示菜单
//! 图标用打包默认图标；菜单事件在 on_menu_event 内直接操作主窗口。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

#[cfg(not(target_os = "linux"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};

/// 托盘是否创建成功。「关闭到托盘」拦截以此为前提——托盘不可用的系统上
/// 隐藏窗口会让应用无法恢复（僵尸进程），此时保持直接退出。
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);

pub fn is_tray_available() -> bool {
    TRAY_AVAILABLE.load(Ordering::Relaxed)
}

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "tray-show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let builder = TrayIconBuilder::with_id("reinagent-tray")
        .icon(app.default_window_icon().expect("default window icon").clone())
        .tooltip("ReinAgent")
        .menu(&menu);
    
    // Linux: 左键显示菜单（libayatana-appindicator 不触发自定义点击事件）
    #[cfg(target_os = "linux")]
    let builder = builder.show_menu_on_left_click(true);
    
    // Windows/macOS: 不自动显示菜单，用自定义左键切换逻辑
    #[cfg(not(target_os = "linux"))]
    let builder = builder.show_menu_on_left_click(false);

    builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => {
                if let Some(window) = app.get_webview_window("main") {
                    crate::focus_main_window(&window);
                }
            }
            "tray-quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Windows/macOS：左键切换窗口显隐
            // Linux：libayatana-appindicator 完全不触发此回调，所有交互走菜单
            #[cfg(not(target_os = "linux"))]
            {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    if let Some(window) = tray.app_handle().get_webview_window("main") {
                        let visible = window.is_visible().unwrap_or(false);
                        if visible {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                }
            }
            // Linux 下避免 unused 警告
            #[cfg(target_os = "linux")]
            {
                let _ = (tray, event);
            }
        })
        .build(app)?;
    TRAY_AVAILABLE.store(true, Ordering::Relaxed);
    Ok(())
}
