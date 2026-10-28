/**
 * BrowserPane —— 右侧面板内嵌浏览器（路线 B：WebView2 / WebKitGTK 子控件）。
 *
 * 增强特性：Chrome 风格水平多标签栏（Tabs Bar），支持多标签自由切换、
 * + 新建标签、× 关闭单个标签、以及在应用中心点击大模型卡片自动打开新标签页。
 */

import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Maximize2,
  Minimize2,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import { useTranslation } from "../../i18n";

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  isPopup?: boolean;
  openerTabId?: string;
}

const START_URL = "https://www.bing.com";

export function BrowserPane({
  url,
  title,
  incomingTabId,
  onClose,
  isMaximized,
  onToggleMaximize,
}: {
  url?: string;
  title?: string;
  incomingTabId?: string;
  onClose: () => void;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
}) {
  const { t } = useTranslation();

  // 多标签状态管理
  const [tabs, setTabs] = useState<BrowserTab[]>(() => {
    const initialUrl = url || START_URL;
    const initialTitle = title || (initialUrl === START_URL ? "Bing" : "新标签页");
    return [{ id: incomingTabId || `tab-${Date.now()}`, title: initialTitle, url: initialUrl }];
  });
  const [activeTabId, setActiveTabId] = useState<string>(
    () => incomingTabId || tabs[0]?.id || `tab-${Date.now()}`,
  );

  const tabsRef = useRef<BrowserTab[]>(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef<string>(activeTabId);
  activeTabIdRef.current = activeTabId;

  const [address, setAddress] = useState(url ?? START_URL);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const boundsRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const lastIncomingTabRef = useRef<string | undefined>(incomingTabId);
  const lastUrlRef = useRef<string | undefined>(url);

  // 页面加载生命周期事件监听
  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    listen<boolean>("browser-page-loading", (event) => {
      if (active) setLoading(Boolean(event.payload));
    })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // 15秒超时守护，防止网络挂死或静默无响应导致刷新按钮永久旋转
  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => {
      setLoading(false);
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [loading]);

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

  // 打开：创建子控件并导航至初始地址
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void (async () => {
      try {
        await invoke("browser_open", { url: address });
        if (disposed) return;
        setReady(true);
        requestAnimationFrame(reportBounds);
      } catch (err) {
        if (!disposed) {
          setLoading(false);
          setError(String(err).slice(0, 300));
        }
      }
    })();
    return () => {
      disposed = true;
      void invoke("browser_close").catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部每次点击大模型卡片传入新的 incomingTabId 时：自动追加新标签页并激活
  useEffect(() => {
    if (!incomingTabId || incomingTabId === lastIncomingTabRef.current) return;
    lastIncomingTabRef.current = incomingTabId;
    const targetUrl = url || START_URL;
    const targetTitle = title || "新标签页";
    const newTab: BrowserTab = {
      id: incomingTabId,
      title: targetTitle,
      url: targetUrl,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(incomingTabId);
    setAddress(targetUrl);
    if (ready) {
      setLoading(true);
      void invoke("browser_navigate", { url: targetUrl }).catch((err) => {
        setLoading(false);
        setError(String(err).slice(0, 300));
      });
    }
  }, [incomingTabId, url, title, ready]);

  // 外部未带 incomingTabId（如常规链接点击）且 url 变化时：追加新标签页
  useEffect(() => {
    if (!url || incomingTabId) return;
    if (url === lastUrlRef.current) return;
    lastUrlRef.current = url;
    const targetTitle = title || url;
    const newTabId = `tab-${Date.now()}`;
    const newTab: BrowserTab = {
      id: newTabId,
      title: targetTitle,
      url,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId);
    setAddress(url);
    if (ready) {
      setLoading(true);
      void invoke("browser_navigate", { url }).catch((err) => {
        setLoading(false);
        setError(String(err).slice(0, 300));
      });
    }
  }, [url, title, incomingTabId, ready]);

  // 监听子 WebView 拦截的 window.open / target="_blank" 弹窗（如 OAuth 登录流）
  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      try {
        const u = await listen<string>("browser-new-window", (event) => {
          if (!active) return;
          const targetUrl = event.payload;
          if (!targetUrl || targetUrl === "about:blank") return;

          let targetTitle = "新标签页";
          try {
            const parsed = new URL(targetUrl);
            targetTitle = parsed.hostname.replace(/^www\./, "");
            if (targetUrl.includes("auth") || targetUrl.includes("login")) {
              targetTitle = "登录认证";
            }
          } catch {
            // fallback
          }
          setTabs((prev) => {
            const existing = prev.find((t) => t.url === targetUrl);
            if (existing) {
              setActiveTabId(existing.id);
              setAddress(targetUrl);
              return prev;
            }
            const newTabId = `tab-popup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const newTab: BrowserTab = {
              id: newTabId,
              title: targetTitle,
              url: targetUrl,
              isPopup: true,
              openerTabId: activeTabIdRef.current,
            };
            setActiveTabId(newTabId);
            setAddress(targetUrl);
            return [...prev, newTab];
          });
          setLoading(true);
          void invoke("browser_navigate", { url: targetUrl }).catch((err) => {
            setLoading(false);
            setError(String(err).slice(0, 300));
          });
        });
        if (active) {
          unlisten = u;
        } else {
          u();
        }
      } catch {
        // web mock fallback
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // 监听原生窗口 close 事件（如 Google / OAuth 认证完成后调用 window.close()）
  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      try {
        const u = await listen("browser-window-close", () => {
          if (!active) return;
          console.log("[ReinAgent] browser-window-close received, closing popup tab:", activeTabIdRef.current);
          const currentTab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
          if (currentTab && tabsRef.current.length > 1) {
            closeTab(currentTab.id);
          }
        });
        if (active) unlisten = u;
        else u();
      } catch {
        // web mock fallback
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [ready]);

  // 在外部系统默认浏览器中打开当前网页
  const handleOpenExternal = async () => {
    if (!address) return;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(address);
    } catch {
      window.open(address, "_blank");
    }
  };

  // 最大化/还原切换时立即刷新 bounds
  useEffect(() => {
    if (!ready) return;
    const raf = requestAnimationFrame(() => {
      reportBounds();
    });
    return () => cancelAnimationFrame(raf);
  }, [ready, isMaximized]);

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

  // 地址栏跟随子 WebView 的实际 URL，并智能识别 OAuth 授权完成自动关闭弹窗切回主站
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      const input = addressRef.current;
      if (input && document.activeElement === input) return; // 输入中不覆盖
      void invoke("browser_current_url")
        .then((u) => {
          if (cancelled || typeof u !== "string" || !u) return;
          setAddress((prev) => (prev === u ? prev : u));
          setTabs((prev) =>
            prev.map((t) => (t.id === activeTabId && t.url !== u ? { ...t, url: u } : t)),
          );

          // 智能 OAuth 回调完成检测：
          // 若当前是 OAuth 弹窗标签页，且检测到 URL 已经回调回到父站域名（如 claude.ai），
          // 或已完成登录跳转至 Google 账户首页，自动关闭弹窗标签页并切回父站刷新生效！
          const currentTab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
          if (currentTab?.isPopup && currentTab.openerTabId) {
            const opener = tabsRef.current.find((t) => t.id === currentTab.openerTabId);
            if (opener) {
              try {
                const currentUrl = new URL(u);
                const openerUrl = new URL(opener.url);
                const isReturnedToOpener = currentUrl.origin === openerUrl.origin &&
                  !u.includes("oauth") &&
                  !u.includes("login") &&
                  !u.includes("callback");
                const isGoogleAccountDone = currentUrl.hostname === "myaccount.google.com";

                if (isReturnedToOpener || isGoogleAccountDone) {
                  console.log("[ReinAgent] OAuth login flow completed, auto-closing popup and switching to opener:", u);
                  closeTab(currentTab.id);
                }
              } catch {}
            }
          }
        })
        .catch(() => {});
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ready, activeTabId]);

  const navigate = (raw: string) => {
    let next = raw.trim();
    if (!next) return;
    if (!/^https?:\/\//i.test(next)) {
      next = /^[\w-]+(\.[\w-]+)+/.test(next)
        ? `https://${next}`
        : `https://www.bing.com/search?q=${encodeURIComponent(next)}`;
    }
    setAddress(next);
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              url: next,
              title: t.title === "新标签页" ? next.replace(/^https?:\/\//, "") : t.title,
            }
          : t,
      ),
    );
    setLoading(true);
    void invoke("browser_navigate", { url: next }).catch((err) => {
      setLoading(false);
      setError(String(err).slice(0, 300));
    });
  };

  const handleReload = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await invoke("browser_reload");
    } catch {
      try {
        await invoke("browser_navigate", { url: address });
      } catch (err) {
        setLoading(false);
        setError(String(err).slice(0, 300));
      }
    }
  };

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

  // 切换标签
  const handleSwitchTab = (tab: BrowserTab) => {
    if (tab.id === activeTabId) return;
    setActiveTabId(tab.id);
    setAddress(tab.url);
    if (ready) {
      setLoading(true);
      void invoke("browser_navigate", { url: tab.url }).catch((err) => {
        setLoading(false);
        setError(String(err).slice(0, 300));
      });
    }
  };

  // 新建标签页
  const handleNewTab = () => {
    const newTabId = `tab-${Date.now()}`;
    const newTab: BrowserTab = {
      id: newTabId,
      title: "新标签页",
      url: START_URL,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId);
    setAddress(START_URL);
    if (ready) {
      setLoading(true);
      void invoke("browser_navigate", { url: START_URL }).catch((err) => {
        setLoading(false);
        setError(String(err).slice(0, 300));
      });
    }
  };

  // 关闭指定标签页，并在关闭弹窗时自动平滑切回父标签页并刷新
  const closeTab = (tabId: string) => {
    const currentTabs = tabsRef.current;
    const nextTabs = currentTabs.filter((t) => t.id !== tabId);
    if (nextTabs.length === 0) {
      // 最后一个标签关闭时退出整个浏览器
      onClose();
      return;
    }
    const closingTab = currentTabs.find((t) => t.id === tabId);
    setTabs(nextTabs);

    if (activeTabIdRef.current === tabId) {
      let targetTab = closingTab?.openerTabId
        ? nextTabs.find((t) => t.id === closingTab.openerTabId)
        : undefined;
      if (!targetTab) {
        const closedIndex = currentTabs.findIndex((t) => t.id === tabId);
        targetTab = nextTabs[Math.max(0, closedIndex - 1)];
      }
      if (targetTab) {
        setActiveTabId(targetTab.id);
        setAddress(targetTab.url);
        if (ready) {
          setLoading(true);
          // 重新导航至父标签页以使已完成写入的 OAuth 凭据 Cookie 立即生效！
          void invoke("browser_navigate", { url: targetTab.url }).catch((err) => {
            setLoading(false);
            setError(String(err).slice(0, 300));
          });
        }
      }
    }
  };

  // 关闭单个标签页
  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    closeTab(tabId);
  };

  return (
    <div className="flex h-full flex-col bg-[var(--bg)] select-none">
      {/* 1. Chrome 风格水平多标签栏 */}
      <div className="flex h-9 shrink-0 items-end bg-[var(--sidebar-bg)] border-b border-[var(--border)] px-2 gap-1 overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar flex-1 min-w-0">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => handleSwitchTab(tab)}
                className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-xs cursor-pointer max-w-[170px] min-w-[90px] border-t border-l border-r transition-all relative select-none ${
                  isActive
                    ? "bg-[var(--bg)] text-[var(--foreground)] font-medium border-[var(--border)] shadow-xs -mb-[1px] z-10"
                    : "bg-transparent text-[var(--text-dim)] hover:text-[var(--foreground)] hover:bg-[var(--surface-hover)] border-transparent"
                }`}
                title={`${tab.title} (${tab.url})`}
              >
                <Globe
                  className={`w-3.5 h-3.5 shrink-0 ${
                    isActive ? "text-sky-400" : "text-[var(--text-dim)]"
                  }`}
                />
                <span className="truncate flex-1 text-xs">{tab.title}</span>
                <button
                  type="button"
                  onClick={(e) => handleCloseTab(e, tab.id)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--foreground)] transition-opacity cursor-pointer shrink-0"
                  title="关闭标签页"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}

          {/* 新建标签 + 按钮 */}
          <button
            type="button"
            onClick={handleNewTab}
            className="p-1 rounded-md text-[var(--text-dim)] hover:text-[var(--foreground)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer shrink-0 ml-0.5"
            title="新建标签页"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 窗口控制：最大化 / 还原 / 关闭浏览器 */}
        <div className="flex items-center gap-0.5 pb-1 pl-2 shrink-0">
          {onToggleMaximize && (
            <button
              type="button"
              onClick={onToggleMaximize}
              title={isMaximized ? t("restore") : t("maximize")}
              className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
              aria-label={isMaximized ? t("restore") : t("maximize")}
            >
              {isMaximized ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
            title="关闭浏览器"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 2. URL 地址与导航栏 */}
      <div className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-[var(--border)] px-2 bg-[var(--bg)]">
        <button
          type="button"
          title="后退"
          onClick={() => void historyNavigate(-1)}
          className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="前进"
          onClick={() => void historyNavigate(1)}
          className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={loading}
          title={loading ? t("refreshing") : t("refresh")}
          aria-label={loading ? t("refreshing") : t("refresh")}
          onClick={() => void handleReload()}
          className={`rounded p-1 text-[var(--text-dim)] transition-opacity cursor-pointer ${
            loading
              ? "cursor-not-allowed opacity-60"
              : "hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          }`}
        >
          <RotateCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1">
          <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--text-dim)]" />
          <input
            type="text"
            ref={addressRef}
            value={address}
            onChange={(e) => setAddress(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
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
          title="在系统默认浏览器中打开当前网页"
          aria-label="在系统默认浏览器中打开当前网页"
          onClick={() => void handleOpenExternal()}
          className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors cursor-pointer shrink-0"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 3. 错误提示条 */}
      {error ? (
        <div className="flex items-center justify-between bg-red-950/60 px-3 py-1 text-xs text-red-300">
          <span className="truncate">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 hover:underline cursor-pointer"
          >
            忽略
          </button>
        </div>
      ) : null}

      {/* 4. 原生子 WebView 占位区（bounds 由前端上报，原生视图绘制在上方） */}
      <div
        ref={slotRef}
        data-testid="browser-webview-slot"
        className="flex-1 w-full bg-[var(--bg)] relative overflow-hidden"
      >
        {!ready && (
          <div className="flex h-full items-center justify-center text-xs text-[var(--text-dim)]">
            浏览器加载中…
          </div>
        )}
      </div>
    </div>
  );
}
