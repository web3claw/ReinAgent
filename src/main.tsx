import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initStorage } from "./lib/storage/db";
import { useAppStore } from "./store/useAppStore";

// 存储初始化（kv / 任务列表 / 用户主目录）必须在 React 渲染前完成，
// 使所有同步读（主题、语言、任务列表、工作区根目录）在首帧就有真实数据。
async function bootstrap() {
  await initStorage();
  // 渲染前水合：store 在模块求值时已创建（此时缓存为空），
  // 这里从缓存重设全部持久化字段，再交给 React 渲染首帧。
  useAppStore.getState().hydratePersisted();
// 远程访问桥：常驻监听 Rust remote_server 事件（手机 WS 请求 → 会话运行时）
void import("./lib/remote/remoteBridge").then((m) => m.startRemoteBridge());
  (window as any).__store = useAppStore;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  // startup-ready 收起启动闪屏（#loading z 999999 全屏 PE:auto）——
  // ⚠ 不能只依赖 rAF：窗口被遮挡时 Chromium 节流 rAF，类永不添加，
  // 闪屏会变成透明点击盾吃掉全部点击（下拉框关不上/按钮点不动的真因）。
  // rAF 保留动画首帧语义，setTimeout 300ms 兜底保证功能必达。
  requestAnimationFrame(() => {
    document.body.classList.add("startup-ready");
  });
  setTimeout(() => {
    document.body.classList.add("startup-ready");
  }, 300);
}

void bootstrap();

