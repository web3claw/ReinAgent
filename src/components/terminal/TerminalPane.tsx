import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createTerminalSession, type TerminalSessionHandle } from "../../lib/terminal/tauriTerminalClient";
import { getTerminalSettings } from "../../lib/terminal/terminalSettings";
import { decideTabClose, moveTabToIndex, tabIndexAtX } from "../../lib/terminal/tabStrip";
import { readTerminalTheme } from "../../lib/terminal/terminalTheme";
import { useAppStore } from "../../store/useAppStore";
import { useTranslation } from "../../i18n";
import { Terminal as TerminalIcon, X, Plus, RotateCw, GripVertical } from "lucide-react";

interface TerminalTab {
  id: string;
  name: string;
}

/** 关闭目标哨兵：面板级关闭（右侧 X）复用同一条确认条。 */
const PANEL_CLOSE_ID = "__panel__";

export interface TerminalPaneProps {
  /** 当前任务工作区（新终端的初始 cwd） */
  workspaceRoot?: string;
}

export function TerminalPane({ workspaceRoot }: TerminalPaneProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const theme = useAppStore((s) => s.theme);
  const isTerminalOpen = useAppStore((s) => s.isTerminalOpen);
  const toggleTerminal = useAppStore((s) => s.toggleTerminal);
  // 终端配置（P2-G2）：kv 读取（设置页保存后重开终端即生效）
  const [settings] = useState(getTerminalSettings);
  /** shell 简名（终端 tab 标签用，去 .exe 后缀） */
  const shellName = (settings.shell.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase() || "shell";

  const [tabs, setTabs] = useState<TerminalTab[]>([{ id: "term-1", name: `${shellName} 1` }]);
  const [activeTab, setActiveTab] = useState<string>("term-1");
  const [status, setStatus] = useState<"connecting" | "connected" | "error">("connecting");
  /** tab id 单调序号（关闭/重排后新建不复用 id） */
  const tabSeqRef = useRef(2);
  /** 关闭二次确认目标（tab id 或 PANEL_CLOSE_ID；null = 无待确认） */
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  /** 拖动中的 tab id（视觉反馈） */
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);

  const sessionRef = useRef<TerminalSessionHandle | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  /** 拖动会话状态（window 监听期间可变） */
  const dragRef = useRef<{ id: string; pointerId: number; moved: boolean } | null>(null);
  /** 拖动结束后的幽灵 click 抑制（grip 拖动不应触发 tab 切换） */
  const suppressClickRef = useRef(false);

  useEffect(() => {
    if (!isTerminalOpen || !containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 16,
      // 终端字体（2026-10-05 修复「Nerd Font 图标显示为方框」）：starship / oh-my-*
      // 等提示符用 Nerd Font 私有区码点渲染图标，普通等宽字体（Consolas/Menlo/
      // Monaco）无这些字形 → 方框。这里按优先级给出 Nerd Font 字体栈，并保留
      // 各平台默认等宽回退（未安装 Nerd Font 时退化为纯文本，不再出现方框乱码行）。
      fontFamily:
        "'FiraCode Nerd Font Mono', 'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', " +
        "'Hack Nerd Font', 'Symbols Nerd Font Mono', 'MesloLGS NF', " +
        "Consolas, Menlo, Monaco, 'DejaVu Sans Mono', 'Courier New', monospace",
      // 配色（LiveAgent 同款）：从 --terminal-{theme}-* 语义 token 解析
      // （深色绿字 / 浅色黑字，定义见 src/styles/global.css）
      theme: readTerminalTheme(theme === "light" ? "light" : "dark"),
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    let isDisposed = false;

    createTerminalSession({
      cols: term.cols || 80,
      rows: term.rows || 24,
      cwd: workspaceRoot || undefined,
      shell: settings.shell || undefined,
      onData: (data) => {
        if (!isDisposed) term.write(data);
      },
    })
      .then((session) => {
        if (isDisposed) {
          session.close();
          return;
        }
        sessionRef.current = session;
        setStatus("connected");

        term.onData((data) => {
          session.write(data);
        });

        term.onResize(({ cols, rows }) => {
          session.resize(cols, rows);
        });
      })
      .catch((err) => {
        console.error("Terminal session error:", err);
        setStatus("error");
        term.writeln("\r\n\x1b[31mFailed to launch native terminal: " + String(err) + "\x1b[0m");
      });

    const handleResize = () => {
      try {
        fitAddon.fit();
      } catch {}
    };
    window.addEventListener("resize", handleResize);

    return () => {
      isDisposed = true;
      window.removeEventListener("resize", handleResize);
      if (sessionRef.current) {
        sessionRef.current.close();
        sessionRef.current = null;
      }
      term.dispose();
      termRef.current = null;
    };
  }, [isTerminalOpen, activeTab, settings.shell, workspaceRoot]);

  // Update theme dynamically（色板来自 CSS 变量：深色绿字 / 浅色黑字）
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = readTerminalTheme(theme === "light" ? "light" : "dark");
  }, [theme]);

  if (!isTerminalOpen) return null;

  const sessionAlive = status === "connected";

  /** grip 拖动重排：window 级 pointer 监听，实时按槽位换位（LiveAgent 坞内拖动语义）。 */
  const beginTabDrag = (event: ReactPointerEvent<HTMLElement>, tabId: string) => {
    if (tabs.length <= 1) return; // 单个 tab 无重排意义
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    dragRef.current = { id: tabId, pointerId, moved: false };
    setDraggingTabId(tabId);

    const measureSlots = () =>
      Array.from(stripRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? []).map(
        (el) => {
          const rect = el.getBoundingClientRect();
          return { id: el.dataset.tabId ?? "", left: rect.left, right: rect.right };
        },
      );

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== pointerId) return;
      drag.moved = true;
      const targetIndex = tabIndexAtX(measureSlots(), e.clientX);
      if (targetIndex < 0) return;
      setTabs((prev) => {
        const currentIndex = prev.findIndex((tab) => tab.id === drag.id);
        if (currentIndex < 0 || currentIndex === targetIndex) return prev;
        return [...moveTabToIndex(prev, drag.id, targetIndex)];
      });
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (dragRef.current?.moved) {
        // click 紧随 pointerup 触发：抑制一次幽灵点击（不切换 tab）
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      dragRef.current = null;
      setDraggingTabId(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const addTab = () => {
    const seq = tabSeqRef.current++;
    const newTab: TerminalTab = { id: `term-${seq}`, name: `${shellName} ${seq}` };
    setTabs([...tabs, newTab]);
    setActiveTab(newTab.id);
  };

  const performCloseTab = (tabId: string) => {
    setPendingCloseId(null);
    const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
    const next = tabs.filter((tab) => tab.id !== tabId);
    if (next.length === 0) {
      // 关闭最后一个 tab = 关闭整个面板；tab 条复位成全新单 tab（重开干净起步）
      const seq = tabSeqRef.current++;
      const fresh: TerminalTab = { id: `term-${seq}`, name: `${shellName} ${seq}` };
      setTabs([fresh]);
      setActiveTab(fresh.id);
      toggleTerminal();
      return;
    }
    setTabs(next);
    if (activeTab === tabId) {
      setActiveTab(next[Math.min(closingIndex, next.length - 1)].id);
    }
  };

  const requestCloseTab = (tabId: string) => {
    if (decideTabClose({ activeTabId: activeTab, closingTabId: tabId, sessionAlive }) === "confirm") {
      setPendingCloseId(tabId);
      return;
    }
    performCloseTab(tabId);
  };

  const requestClosePanel = () => {
    if (sessionAlive) {
      setPendingCloseId(PANEL_CLOSE_ID);
      return;
    }
    toggleTerminal();
  };

  const confirmPendingClose = () => {
    const target = pendingCloseId;
    if (target === null) return;
    if (target === PANEL_CLOSE_ID) {
      setPendingCloseId(null);
      toggleTerminal();
      return;
    }
    performCloseTab(target);
  };

  /** 确认条里要关闭的终端名（面板级 = 当前活动 tab 名）。 */
  const closingName =
    pendingCloseId === null
      ? null
      : pendingCloseId === PANEL_CLOSE_ID
        ? tabs.find((tab) => tab.id === activeTab)?.name ?? shellName
        : tabs.find((tab) => tab.id === pendingCloseId)?.name ?? shellName;

  return (
    <div className="flex flex-col h-full min-h-[120px] border-t border-[var(--border)] bg-[var(--bg-sunken)]">
      {/* 终端顶栏 */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[var(--bg-elev)] border-b border-[var(--border)] text-xs select-none">
        <div ref={stripRef} className="flex items-center gap-1 min-w-0 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (suppressClickRef.current) return;
                setActiveTab(tab.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") setActiveTab(tab.id);
              }}
              className={`flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 py-1 text-xs transition-colors ${
                activeTab === tab.id
                  ? "border-[var(--border)] bg-[var(--bg)] font-medium text-[var(--text)]"
                  : "border-transparent text-[var(--text-dim)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]"
              } ${draggingTabId === tab.id ? "opacity-60" : ""}`}
            >
              {/* 拖动把手（LiveAgent GripVertical 语义：仅把手可拖，点 tab 本体仍为切换） */}
              <span
                title="拖动调整顺序"
                onPointerDown={(event) => beginTabDrag(event, tab.id)}
                className={`-ml-0.5 touch-none text-[var(--text-dim)] hover:text-[var(--text)] ${
                  draggingTabId === tab.id ? "cursor-grabbing" : "cursor-grab"
                }`}
              >
                <GripVertical className="h-3 w-3" />
              </span>
              <TerminalIcon className="h-3 w-3" />
              <span>{tab.name}</span>
              {tab.id === activeTab && status === "connected" ? (
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              ) : null}
              {tab.id === activeTab && status === "error" ? (
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
              ) : null}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  requestCloseTab(tab.id);
                }}
                className="ml-0.5 rounded p-0.5 text-[var(--text-dim)] transition-colors hover:bg-[var(--bg-elev-2)] hover:text-[var(--danger)]"
                title="关闭终端"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button
            onClick={addTab}
            className="shrink-0 rounded p-1 text-[var(--text-dim)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]"
            title="新建终端"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => fitAddonRef.current?.fit()}
            className="p-1 rounded text-[var(--text-dim)] hover:text-[var(--text)]"
            title="刷新自适应"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={requestClosePanel}
            className="p-1 rounded text-[var(--text-dim)] hover:text-[var(--text)]"
            title="关闭面板"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 关闭二次确认条（LiveAgent TerminalPaneHost closeRequest 同款：画面之上内联红条） */}
      {pendingCloseId !== null ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--danger)]/20 bg-[var(--danger)]/5 px-3 py-2 text-xs text-[var(--danger)]">
          <span className="min-w-0 flex-1 truncate">
            {t("terminalCloseRunning").replace("{name}", closingName ?? "")}
          </span>
          <button
            type="button"
            onClick={() => setPendingCloseId(null)}
            className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text)] transition-colors hover:bg-[var(--bg-elev-2)]"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={confirmPendingClose}
            className="shrink-0 rounded-lg bg-[var(--danger)] px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            {t("close")}
          </button>
        </div>
      ) : null}

      {/* 终端画布容器 */}
      <div ref={containerRef} className="flex-1 p-2 overflow-hidden" />
    </div>
  );
}
