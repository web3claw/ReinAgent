import { createRoot } from "react-dom/client";
import { RemoteApp } from "./RemoteApp";
import "./remote.css";

// 主题先行：首帧前落 data-theme，避免闪白（dark 默认，localStorage 记忆覆盖）
{
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem("reinagent-remote-theme");
  } catch {
    /* ignore */
  }
  const resolved =
    saved === "light"
      ? "light"
      : saved === "dark"
        ? "dark"
        : window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
  document.documentElement.setAttribute("data-theme", resolved);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", resolved);
}

const root = createRoot(document.getElementById("root")!);
root.render(<RemoteApp />);
