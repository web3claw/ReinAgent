import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import path from "node:path";

// 手机远控前端（Web Remote Control）独立构建：
// 产物输出到 src-tauri/remote_assets/app，由 remote_server.rs include_dir! 内嵌并同源托管，
// 手机经局域网 / Cloudflare 隧道 / 自定义域名直接访问（与 WS 同源，无 CORS）。
export default defineConfig(() => ({
  // root 指向 remote-mobile：index.html 落在产物根（Rust 侧 GET / 直接命中）
  root: "src/remote-mobile",
  plugins: [react(), tailwindcss()],
  base: "/",
  // 手机端不复制 public/（桌面图标/音效资源与远控无关），产物只含自身 chunk
  publicDir: false,
  resolve: {
    preserveSymlinks: true,
  },
  build: {
    // root 收窄后 outDir 相对 root 解析 → 必须绝对路径指回仓库内嵌目录
    outDir: path.resolve(__dirname, "src-tauri/remote_assets/app"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "src/remote-mobile/index.html"),
    },
  },
  clearScreen: false,
  // 远端页面开发预览：bun run dev:remote 后经桌面远控服务器或任意静态服务托管验证
  server: {
    port: 1422,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
