/**
 * CodeViewerPaneHost —— 右侧代码/变更预览面板的宿主壳。
 * 从全局 store 读取 codeViewerSource；包 PlatformProvider（tauri 实现）+
 * ZCode 移植的 PreviewPane；顶部提供标题栏与关闭按钮（PreviewPane 自身不渲染关闭）。
 */
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { BundledLanguage } from "shiki";
import { PlatformProvider } from "./hooks/usePlatform";
import { PreviewPane } from "./PreviewPane";
import { previewPlatform } from "./previewPlatform";
import type { CodeViewerSource } from "./lib/codeViewer";
import { resolveWorkspacePath } from "../lib/agent/workspace";
import { useAppStore } from "../store/useAppStore";
import { SubagentsPanel } from "../components/chat/SubagentsPanel";
import { SubagentReplay } from "../components/chat/SubagentReplay";
import { GitPanel } from "../components/git/GitPanel";
import { FilesPanel } from "../components/git/FilesPanel";
import { BrowserPane } from "../components/browser/BrowserPane";

type CodeViewerSourceInput = Extract<
  NonNullable<ReturnType<typeof useAppStore.getState>["codeViewerSource"]>,
  { type: "file" | "text" | "patch" | "multi-file-diff" | "subagents" | "git" | "files" | "browser" | "code-review" }
>;

function buildSource(
  input: Exclude<NonNullable<CodeViewerSourceInput>, { type: "subagents" | "git" | "files" | "browser" }>,
  workspacePath?: string
): CodeViewerSource {
  // 子代理形态没有 path；其余形态按工作区根解析相对路径
  const resolvePath = (rawPath?: string): string | undefined => {
    if (!rawPath) return undefined;
    if (!workspacePath) return rawPath;
    return resolveWorkspacePath(rawPath, workspacePath);
  };
  const resolvedPath = resolvePath(input.path);
  if (input.type === "text") {
    return {
      type: "text",
      title: input.title,
      content: input.content,
      language: input.language as BundledLanguage,
      ...(resolvedPath ? { path: resolvedPath } : {}),
      ...(workspacePath ? { workspacePath } : {}),
    };
  }
  if (input.type === "file") {
    return {
      type: "file",
      title: input.title,
      path: resolvedPath ?? input.path,
      ...(workspacePath ? { workspacePath } : {}),
    };
  }
  if (input.type === "code-review") {
    return {
      type: "code-review",
      title: input.title,
      path: resolvedPath ?? input.path,
      review: input.review,
      ...(workspacePath ? { workspacePath } : {}),
    };
  }
  // patch / multi-file-diff 宿主当前不直接构造；兜底按纯文本展示原始 patch。
  const fallbackText =
    input.type === "patch" ? input.patch : "// 该变更类型在当前宿主中不可用";
  return {
    type: "text",
    title: input.title,
    content: fallbackText,
    language: "diff",
    ...(resolvedPath ? { path: resolvedPath } : {}),
    ...(workspacePath ? { workspacePath } : {}),
  };
}

export function CodeViewerPaneHost({ workspacePath }: { workspacePath?: string }) {
  const codeViewerSource = useAppStore((state) => state.codeViewerSource);
  const openCodeViewer = useAppStore((state) => state.openCodeViewer);
  const closeCodeViewer = useAppStore((state) => state.closeCodeViewer);
  // 可调宽度（P2-G2 尾巴）：localStorage 持久化，拖拽左缘调宽
  const [paneW, setPaneW] = useState(() => {
    const v = Number(localStorage.getItem("reinagent-preview-w"));
    return v >= 280 && v <= 800 ? v : 460;
  });
  /** 拖拽左缘调宽（mouse 计算在 move/up 里做，防止闭包过期） */
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      setPaneW(Math.min(800, Math.max(280, paneW - (ev.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      localStorage.setItem("reinagent-preview-w", String(paneW));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  // 子代理完整回放（P2 尾巴 #7）：面板内二级视图（focusId 运行 → 回放转录）
  const [replayRunId, setReplayRunId] = useState<string | null>(null);
  useEffect(() => {
    // 每次面板重开/切换源时退出回放态
    setReplayRunId(null);
  }, [codeViewerSource]);

  if (!codeViewerSource) {
    return null;
  }

  // 浏览器面板（路线 B：WebView2 子控件；关闭面板时销毁子控件）
  if (codeViewerSource.type === "browser") {
    return (
      <div className="relative flex h-full flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]" style={{ width: paneW }}>
        <div
          onMouseDown={startResize}
          className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-[var(--brand)]/30 transition-colors z-20"
        />
        <BrowserPane
          url={codeViewerSource.url}
          onClose={() => {
            closeCodeViewer();
          }}
        />
      </div>
    );
  }

  // Git 面板（P2-D）：分支/变更/提交历史，不走 PreviewPane。
  if (codeViewerSource.type === "git") {
    return (
      <div className="relative flex h-full flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]" style={{ width: paneW }}>
        {/* 左缘拖拽调宽把手 */}
        <div
          onMouseDown={startResize}
          className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-[var(--brand)]/30 transition-colors z-10"
        />
        <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] bg-[var(--bg-sunken)] border border-[var(--border)] text-[var(--text-dim)]">
              Git
            </span>
            <span className="truncate text-xs text-[var(--text)]">{codeViewerSource.title}</span>
          </div>
          <button
            type="button"
            onClick={() => openCodeViewer({ type: "files", title: "文件树" })}
            className="flex-shrink-0 rounded px-2 py-1 text-xs text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            文件树
          </button>
          <button
            type="button"
            onClick={closeCodeViewer}
            className="flex-shrink-0 rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            aria-label="关闭 Git 面板"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <GitPanel workspacePath={workspacePath} />
        </div>
      </div>
    );
  }

  // 工作区文件树（P2-D1）：懒加载目录树，不走 PreviewPane。
  if (codeViewerSource.type === "files") {
    return (
      <div className="relative flex h-full flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]" style={{ width: paneW }}>
        {/* 左缘拖拽调宽把手 */}
        <div
          onMouseDown={startResize}
          className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-[var(--brand)]/30 transition-colors z-10"
        />
        <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] bg-[var(--bg-sunken)] border border-[var(--border)] text-[var(--text-dim)]">
              文件
            </span>
            <span className="truncate text-xs text-[var(--text)]">{codeViewerSource.title}</span>
          </div>
          <button
            type="button"
            onClick={() => openCodeViewer({ type: "git", title: "Git" })}
            className="flex-shrink-0 rounded px-2 py-1 text-xs text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            Git
          </button>
          <button
            type="button"
            onClick={closeCodeViewer}
            className="flex-shrink-0 rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            aria-label="关闭文件树"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FilesPanel
            workspacePath={workspacePath}
            onOpenFile={(relPath) => {
              const path = workspacePath ? `${workspacePath}/${relPath}` : relPath;
              openCodeViewer({ type: "file", title: relPath, path });
            }}
          />
        </div>
      </div>
    );
  }

  // 子代理目录面板（P1-6 增量）：实时订阅 registry，不走 PreviewPane。
  if (codeViewerSource.type === "subagents") {
    return (
      <div className="relative flex h-full flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]" style={{ width: paneW }}>
        {/* 左缘拖拽调宽把手 */}
        <div
          onMouseDown={startResize}
          className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-[var(--brand)]/30 transition-colors z-10"
        />
        <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] bg-[var(--bg-sunken)] border border-[var(--border)] text-[var(--text-dim)]">
              子代理
            </span>
            <span className="truncate text-xs text-[var(--text)]">{codeViewerSource.title}</span>
          </div>
          <button
            type="button"
            onClick={closeCodeViewer}
            className="flex-shrink-0 rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            aria-label="关闭子代理面板"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SubagentsPanel focusId={codeViewerSource.focusId} onOpenReplay={setReplayRunId} />
        </div>
        {replayRunId ? (
          <SubagentReplay
            runId={replayRunId}
            onBack={() => setReplayRunId(null)}
          />
        ) : null}
      </div>
    );
  }

  const isPatch = codeViewerSource.type === "patch";

  return (
    <div className="flex h-full flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]">
      <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] bg-[var(--bg-sunken)] border border-[var(--border)] text-[var(--text-dim)]"
          >
            {isPatch ? "变更对比" : "文件"}
          </span>
          <span className="truncate text-xs text-[var(--text)]" title={codeViewerSource.title}>
            {codeViewerSource.title}
          </span>
        </div>
        <button
          type="button"
          onClick={closeCodeViewer}
          className="flex-shrink-0 rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          aria-label="关闭预览"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <PlatformProvider platform={previewPlatform}>
          <PreviewPane
            source={buildSource(codeViewerSource, workspacePath)}
            onClose={closeCodeViewer}
            workspacePath={workspacePath}
          />
        </PlatformProvider>
      </div>
    </div>
  );
}
