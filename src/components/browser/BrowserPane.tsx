/**
 * BrowserPane —— 右侧面板内嵌浏览器（路线 B：WebView2 子控件）。
 *
 * 布局：顶部 URL 栏（前端 UI），下方为「镂空」占位区——Rust 侧 WebView2
 * Controller 的 bounds 精确对齐占位区矩形（物理像素），原生网页渲染在
 * Tauri WebView 之上。占位区必须保持无前端可交互元素（会被子控件遮挡）。
 * bounds 同步：ResizeObserver + 窗口 resize 时上报；卸载时 browser_close。
 */

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, ArrowRight, Globe, RotateCw, X } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";

const START_URL = "https://www.bing.com";

export function BrowserPane({ url, onClose }: { url?: string; onClose: () => void }) {
  const openCodeViewer = useAppStore((state) => state.openCodeViewer);
  const [address, setAddress] = useState(url ?? START_URL);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const boundsRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const reportBounds = () => {
    const el = slotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    // 面板相对主窗口视口 → 物理像素（WebView2 bounds 相对父窗口客户区）
    const x = Math.round(rect.left * dpr);
    const y = Math.round(rect.top * dpr);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    const prev = boundsRef.current;
    if (prev && prev.x === x && prev.y === y && prev.w === w && prev.h === h) return;
    boundsRef.current = { x, y, w, h };
    invoke("browser_set_bounds", { x, y, width: w, height: h }).catch(() => {});
  };

  // 打开：创建子控件并导航
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        await invoke("browser_open", { url: address });
        if (disposed) return;
        setReady(true);
        requestAnimationFrame(reportBounds);
      } catch (err) {
        if (!disposed) setError(String(err).slice(0, 300));
      }
    })();
    return () => {
      disposed = true;
      void invoke("browser_close").catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // bounds 同步：ResizeObserver + 窗口 resize
  useEffect(() => {
    if (!ready) return;
    const el = slotRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => reportBounds());
    ro.observe(el);
    const onWinResize = () => requestAnimationFrame(reportBounds);
    window.addEventListener("resize", onWinResize);
    const interval = window.setInterval(reportBounds, 1500); // 布局漂移兜底
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const navigate = (raw: string) => {
    let next = raw.trim();
    if (!next) return;
    if (!/^https?:\/\//i.test(next)) {
      next = /^[\w-]+(\.[\w-]+)+/.test(next) ? `https://${next}` : `https://www.bing.com/search?q=${encodeURIComponent(next)}`;
    }
    setAddress(next);
    void invoke("browser_navigate", { url: next }).catch((err) => setError(String(err).slice(0, 300)));
  };

  /** 历史导航：子 WebView 内 history.back/forward。 */
  const historyNavigate = async (delta: number) => {
    try {
      await invoke("browser_eval", {
        js: delta < 0 ? "history.back()" : "history.forward()",
      });
      setTimeout(() => {
        void invoke("browser_current_url")
          .then((u) => typeof u === "string" && u && setAddress(u))
          .catch(() => {});
      }, 400);
    } catch {
      /* 无历史时静默 */
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* URL 栏（在 WebView 区域外，不被子控件遮挡） */}
      <div className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-[var(--border)] px-2">
        <button
          type="button"
          title="后退"
          onClick={() => void historyNavigate(-1)}
          className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="前进"
          onClick={() => void historyNavigate(1)}
          className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="刷新"
          onClick={() => navigate(address)}
          className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1">
          <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--text-dim)]" />
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                navigate(e.currentTarget.value);
              }
            }}
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-[var(--text)] focus:outline-none"
            placeholder="输入网址或搜索词"
          />
        </div>
        <button
          type="button"
          onClick={() => openCodeViewer({ type: "files", title: "文件树" })}
          className="flex-shrink-0 rounded px-2 py-1 text-xs text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          文件
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          aria-label="关闭浏览器"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 镂空区：WebView2 子控件渲染于此矩形之上；就绪前显示占位提示 */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={slotRef}
          className="absolute inset-0"
          style={{ background: ready ? "transparent" : undefined }}
        />
        {!ready ? (
          <div className="absolute inset-0 flex items-center justify-center">
            {error ? (
              <p className="max-w-[80%] break-all text-center text-xs text-[var(--danger)]">{error}</p>
            ) : (
              <p className="text-xs text-[var(--text-dim)]">正在启动内嵌浏览器…</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
