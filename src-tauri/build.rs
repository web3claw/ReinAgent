fn main() {
    // 手机远控前端构建产物目录：Vite(vite.remote.config.ts) 输出到 remote_assets/app，
    // 由 remote_server.rs include_dir! 编译期内嵌。全新克隆该目录不存在会导致
    // include_dir! 编译失败，这里在编译前兜底创建（构建产物不入库）。
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let app_dir = std::path::Path::new(&manifest_dir).join("remote_assets").join("app");
    let _ = std::fs::create_dir_all(&app_dir);
    println!("cargo:rerun-if-changed=remote_assets/app");

    tauri_build::build()
}

