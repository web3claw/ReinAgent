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
  (window as any).__store = useAppStore;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  requestAnimationFrame(() => {
    document.body.classList.add("startup-ready");
  });
}

void bootstrap();

