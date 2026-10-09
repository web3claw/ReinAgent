// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        gtk::glib::set_prgname(Some("ReinAgent"));
        gtk::glib::set_application_name("ReinAgent");
        // 立即向窗口管理器/GNOME通知启动反馈已受理，解除鼠标转圈并恢复Dock后续点击
        gdk::notify_startup_complete();
    }
    reinagent_lib::run()
}
