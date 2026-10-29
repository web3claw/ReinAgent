import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Search,
  Copy,
  Check,
  CornerDownLeft,
  Trash2,
  FolderOpen,
  FileText,
  Clock,
  Download,
  ArrowUp,
} from "lucide-react";
import {
  readGlobalUserPrompts,
  deleteGlobalUserPrompt,
  clearGlobalUserPrompts,
  subscribeGlobalUserPrompts,
  formatLocalTimestamp,
  resolveGlobalPromptsLogPath,
  type UserPromptEntry,
} from "../../lib/chat/userPromptHistory";
import { toast } from "../lw/ui/toast";
import { useTranslation } from "../../i18n";

export interface PromptHistoryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectPrompt: (text: string) => void;
  onDirectSend?: (text: string) => void;
  isStreaming?: boolean;
}

export function PromptHistoryDrawer({
  isOpen,
  onClose,
  onSelectPrompt,
  onDirectSend,
  isStreaming = false,
}: PromptHistoryDrawerProps) {
  const { t } = useTranslation();
  const [prompts, setPrompts] = useState<UserPromptEntry[]>(() => readGlobalUserPrompts());
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 监听历史记录变更
  useEffect(() => {
    if (!isOpen) return;
    setPrompts(readGlobalUserPrompts());
    const unsubscribe = subscribeGlobalUserPrompts(() => {
      setPrompts(readGlobalUserPrompts());
    });
    return unsubscribe;
  }, [isOpen]);

  // 按关键词过滤（prompts 本身已默认按使用次数降序排列）
  const filteredPrompts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return prompts;
    return prompts.filter((item) => {
      return item.content.toLowerCase().includes(query);
    });
  }, [prompts, searchQuery]);

  if (!isOpen) return null;

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    toast.success(t("copied", "已复制到剪贴板"));
    setTimeout(() => {
      setCopiedId(null);
    }, 1500);
  };

  const handleDirectSend = (text: string) => {
    if (isStreaming) {
      toast.warning("正在生成中，请稍候再发送");
      return;
    }
    if (onDirectSend) {
      onDirectSend(text);
      onClose();
    }
  };

  const handleSelect = (text: string) => {
    onSelectPrompt(text);
    toast.success("已填入输入框");
    onClose();
  };

  const handleDelete = (id: string) => {
    deleteGlobalUserPrompt(id);
    toast.success("已删除记录");
  };

  const handleClearAll = () => {
    if (prompts.length === 0) return;
    if (window.confirm("确定要清空所有界面上的发言历史记录吗？（本地总账本 Markdown 文件将完整保留）")) {
      clearGlobalUserPrompts();
      toast.success("已清空发言历史");
    }
  };

  const handleOpenLogFolder = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const fullPath = resolveGlobalPromptsLogPath();
      const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      await invoke("open_in_file_manager", { path: parentDir || null });
    } catch (e) {
      console.warn("无法打开目录:", e);
      toast.warning(`本地总账本路径: ${resolveGlobalPromptsLogPath()}`);
    }
  };

  const handleExportMarkdown = () => {
    if (prompts.length === 0) {
      toast.warning("暂无记录可导出");
      return;
    }
    const content = prompts
      .map(
        (p) =>
          `### [${formatLocalTimestamp(p.timestamp)}] 使用次数: ${p.usageCount || 1} 次\n\n> ${p.content.replace(/\n/g, "\n> ")}\n\n---`,
      )
      .join("\n\n");
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `user_prompts_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("已生成 Markdown 下载");
  };

  const drawerContent = (
    <div
      className="fixed inset-0 z-[9999] flex justify-end bg-black/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      {/* 抽屉面板主体（阻止事件穿透） */}
      <div
        className="relative w-full max-w-lg h-full bg-[var(--sidebar-bg)] border-l border-[var(--border)] shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-[var(--border)] bg-[var(--bg)]/80">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-[var(--text)]">发言历史总账本</h2>
            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg)] border border-[var(--border)] text-[var(--text-secondary)] font-mono">
              {prompts.length} 条
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleOpenLogFolder}
              className="p-1.5 rounded-md hover:bg-[var(--sidebar-hover)] text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors"
              title="打开本地日志目录 (~/.ReinAgent/history)"
            >
              <FolderOpen className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleExportMarkdown}
              className="p-1.5 rounded-md hover:bg-[var(--sidebar-hover)] text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors"
              title="导出为 Markdown 文件"
            >
              <Download className="w-4 h-4" />
            </button>
            {prompts.length > 0 && (
              <button
                type="button"
                onClick={handleClearAll}
                className="p-1.5 rounded-md hover:bg-red-500/10 text-[var(--text-secondary)] hover:text-red-500 transition-colors"
                title="清空界面记录"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-[var(--sidebar-hover)] text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors ml-1"
              title="关闭 (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 搜索过滤栏 */}
        <div className="p-3 border-b border-[var(--border)] bg-[var(--bg)]/40">
          <div className="relative flex items-center">
            <Search className="w-3.5 h-3.5 absolute left-3 text-[var(--text-secondary)] pointer-events-none" />
            <input
              type="text"
              placeholder="搜索历史发言内容..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--bg)] border border-[var(--border)] rounded-md text-[var(--text)] placeholder:text-[var(--text-secondary)]/60 focus:outline-hidden focus:border-[var(--accent)] transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 p-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--text)]"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* 列表区 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {filteredPrompts.length === 0 ? (
            <div className="h-64 flex flex-col items-center justify-center text-center p-6 text-[var(--text-secondary)]">
              <FileText className="w-10 h-10 opacity-30 mb-2 stroke-[1.5]" />
              <p className="text-sm font-medium">
                {searchQuery ? "未找到匹配的发言记录" : "暂无历史发言记录"}
              </p>
              <p className="text-xs opacity-75 mt-1">
                {searchQuery
                  ? "请尝试其他关键词"
                  : "在对话框发送的每一句话都将自动记录在此，并按使用频次排列"}
              </p>
            </div>
          ) : (
            filteredPrompts.map((item) => {
              const isCopied = copiedId === item.id;
              return (
                <div
                  key={item.id}
                  className="group relative flex flex-col rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2.5 hover:border-[var(--accent)]/50 transition-all shadow-xs"
                >
                  {/* 顶部单行：时间戳 + 使用次数徽标（左侧）与 操作按钮（右侧） */}
                  <div className="flex items-center justify-between text-[11px] mb-1.5 gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[var(--text-secondary)] text-[10px]">
                        {formatLocalTimestamp(item.timestamp)}
                      </span>
                      <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20 font-mono">
                        {item.usageCount || 1} 次
                      </span>
                    </div>

                    {/* 按钮上移至右上角 */}
                    <div className="flex items-center gap-1">
                      {onDirectSend && (
                        <button
                          type="button"
                          disabled={isStreaming}
                          onClick={() => handleDirectSend(item.content)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all font-medium cursor-pointer shadow-xs"
                          title={isStreaming ? "正在生成中..." : "直接发送到当前对话"}
                        >
                          <ArrowUp className="w-2.5 h-2.5" />
                          发送
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => handleSelect(item.content)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white transition-colors font-medium cursor-pointer"
                        title="填入输入框继续编辑"
                      >
                        <CornerDownLeft className="w-2.5 h-2.5" />
                        填入
                      </button>

                      <button
                        type="button"
                        onClick={() => handleCopy(item.id, item.content)}
                        className="p-1 rounded text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--sidebar-hover)] transition-colors cursor-pointer"
                        title="复制"
                      >
                        {isCopied ? (
                          <Check className="w-3 h-3 text-emerald-500" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDelete(item.id)}
                        className="p-1 rounded text-[var(--text-secondary)] hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
                        title="删除记录"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* 发言内容主体（无底部多余栏） */}
                  <div className="text-xs text-[var(--text)] whitespace-pre-wrap break-words leading-relaxed select-text font-sans">
                    {item.content}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 底部信息栏 */}
        <div className="p-3 border-t border-[var(--border)] bg-[var(--bg)]/70 text-[11px] text-[var(--text-secondary)] flex items-center justify-between">
          <div className="truncate max-w-[320px]" title={resolveGlobalPromptsLogPath()}>
            本地账本: <span className="font-mono text-[10px] opacity-80">{resolveGlobalPromptsLogPath()}</span>
          </div>
          <span className="text-[10px] opacity-75">按使用频次排列</span>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined"
    ? createPortal(drawerContent, document.body)
    : drawerContent;
}
