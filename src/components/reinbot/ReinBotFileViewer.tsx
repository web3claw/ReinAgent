import { useState, useEffect, useCallback } from "react";
import {
  FileText,
  FileCode,
  Copy,
  FolderOpen,
  Loader2,
  AlertCircle,
  X,
  RotateCw,
} from "lucide-react";
import { MarkdownText } from "../chat/MarkdownText";
import { toast } from "../lw/ui/toast";

export interface ReinBotFileViewerProps {
  filePath: string;
  fileName: string;
  onClose?: () => void;
  onOpenFolder?: () => void;
}

export function ReinBotFileViewer({
  filePath,
  fileName,
  onClose,
  onOpenFolder,
}: ReinBotFileViewerProps) {
  const [content, setContent] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const isMarkdown = fileName.toLowerCase().endsWith(".md");

  const loadContent = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const text = await invoke<string>("fs_read_file", { path: filePath });
      setContent(text);
    } catch (err) {
      console.warn("[ReinBotFileViewer] fs_read_file failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    void loadContent();
  }, [loadContent]);

  const handleCopyContent = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      toast.success("文件内容已复制到剪贴板");
    } catch (err) {
      console.warn("Copy failed:", err);
    }
  };

  const getHeaderIcon = () => {
    if (isMarkdown) return <FileText className="w-4 h-4 text-[var(--brand)]" />;
    return <FileCode className="w-4 h-4 text-emerald-500" />;
  };

  return (
    <div className="flex flex-col h-full w-full bg-[var(--surface)] overflow-hidden select-text">
      {/* 顶部操作条 */}
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--bg-sunken)] border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {getHeaderIcon()}
          <span className="text-xs font-semibold text-[var(--text)] truncate max-w-[200px]" title={fileName}>
            {fileName}
          </span>
          <span className="text-[10px] font-mono text-[var(--text-muted)] bg-[var(--surface)] px-1.5 py-0.5 rounded border border-[var(--border)] shrink-0 truncate max-w-[120px]">
            {isMarkdown ? "Markdown" : "文件预览"}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => void loadContent()}
            disabled={isLoading}
            className="p-1.5 rounded hover:bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors cursor-pointer"
            title="刷新"
          >
            <RotateCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => void handleCopyContent()}
            disabled={!content}
            className="p-1.5 rounded hover:bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors cursor-pointer"
            title="复制全文"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          {onOpenFolder && (
            <button
              type="button"
              onClick={onOpenFolder}
              className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-[var(--surface)] hover:bg-[var(--surface-hover)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors cursor-pointer"
              title="在操作系统默认文件管理器中打开所在文件夹"
            >
              <FolderOpen className="w-3 h-3 text-[var(--brand)]" />
              <span>所在目录</span>
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded hover:bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors cursor-pointer ml-1"
              title="关闭预览"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 路径详情 */}
      <div className="px-3 py-1 bg-[var(--surface)] border-b border-[var(--border)]/60 text-[10px] text-[var(--text-muted)] font-mono truncate select-all">
        {filePath}
      </div>

      {/* 内容展示区 */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-[var(--text-muted)]">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--brand)] mb-2" />
            <p className="text-xs">正在加载文件内容...</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-rose-500 space-y-2">
            <AlertCircle className="w-6 h-6" />
            <p className="text-xs font-medium">读取文件失败</p>
            <p className="text-[11px] text-[var(--text-muted)] font-mono max-w-sm">{error}</p>
          </div>
        ) : isMarkdown ? (
          <div className="text-sm leading-relaxed text-[var(--text)]">
            <MarkdownText text={content} />
          </div>
        ) : (
          <pre className="font-mono text-xs leading-relaxed text-[var(--text)] whitespace-pre-wrap break-all p-3 rounded-lg bg-[var(--bg-sunken)] border border-[var(--border)]">
            <code>{content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
