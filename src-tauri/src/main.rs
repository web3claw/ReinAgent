// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        gtk::glib::set_prgname(Some("ReinAgent"));
        gtk::glib::set_application_name("ReinAgent");
    }
    reinagent_lib::run()
}
