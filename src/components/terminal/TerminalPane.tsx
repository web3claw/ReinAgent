import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createTerminalSession, type TerminalSessionHandle } from "../../lib/terminal/tauriTerminalClient";
import { getTerminalSettings } from "../../lib/terminal/terminalSettings";
import { useAppStore } from "../../store/useAppStore";
import { Terminal as TerminalIcon, X, Plus, RotateCw } from "lucide-react";

interface TerminalTab {
  id: string;
  name: string;
}

export interface TerminalPaneProps {
  /** 当前任务工作区（新终端的初始 cwd） */
  workspaceRoot?: string;
}

export function TerminalPane({ workspaceRoot }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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

  const sessionRef = useRef<TerminalSessionHandle | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!isTerminalOpen || !containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Consolas, Menlo, Monaco, 'Courier New', monospace",
      theme:
        theme === "dark"
          ? {
              background: "#0e0f14",
              foreground: "#e6e8ee",
              cursor: "#5b8cff",
              selectionBackground: "#3a5db044",
            }
          : {
              background: "#f8fafc",
              foreground: "#0f172a",
              cursor: "#2563eb",
              selectionBackground: "#2563eb33",
            },
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

  // Update theme dynamically
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme =
      theme === "dark"
        ? {
            background: "#0e0f14",
            foreground: "#e6e8ee",
            cursor: "#5b8cff",
            selectionBackground: "#3a5db044",
          }
        : {
            background: "#f8fafc",
            foreground: "#0f172a",
            cursor: "#2563eb",
            selectionBackground: "#2563eb33",
          };
  }, [theme]);

  if (!isTerminalOpen) return null;

  return (
    <div className="flex flex-col h-full border-t border-[var(--border)] bg-[var(--bg-sunken)]">
      {/* 终端顶栏 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--bg-elev)] border-b border-[var(--border)] text-xs select-none">
        <div className="flex items-center gap-2">
          <TerminalIcon className="w-3.5 h-3.5 text-[var(--accent)]" />
          <div className="flex items-center gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-2.5 py-1 rounded text-xs transition-colors flex items-center gap-1.5 ${
                  activeTab === tab.id
                    ? "bg-[var(--bg)] text-[var(--text)] font-medium border border-[var(--border)]"
                    : "text-[var(--text-dim)] hover:text-[var(--text)]"
                }`}
              >
                <span>{tab.name}</span>
                {status === "connected" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                )}
                {status === "error" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
                )}
              </button>
            ))}
            <button
              onClick={() => {
                const nextNum = tabs.length + 1;
                const newTab = { id: `term-${nextNum}`, name: `${shellName} ${nextNum}` };
                setTabs([...tabs, newTab]);
                setActiveTab(newTab.id);
              }}
              className="p-1 rounded text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--bg-elev-2)]"
              title="新建终端"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
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
            onClick={toggleTerminal}
            className="p-1 rounded text-[var(--text-dim)] hover:text-[var(--text)]"
            title="关闭面板"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 终端画布容器 */}
      <div ref={containerRef} className="flex-1 p-2 overflow-hidden" />
    </div>
  );
}
