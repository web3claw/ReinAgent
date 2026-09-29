/**
 * CodeViewerPaneHost —— 右侧代码/变更预览面板的宿主壳。
 * 从全局 store 读取 codeViewerSource；包 PlatformProvider（tauri 实现）+
 * ZCode 移植的 PreviewPane；顶部提供标题栏与关闭按钮（PreviewPane 自身不渲染关闭）。
 */
import { X } from "lucide-react";
import type { BundledLanguage } from "shiki";
import { PlatformProvider } from "./hooks/usePlatform";
import { PreviewPane } from "./PreviewPane";
import { previewPlatform } from "./previewPlatform";
import type { CodeViewerSource } from "./lib/codeViewer";
import { resolveWorkspacePath } from "../lib/agent/workspace";
import { useAppStore } from "../store/useAppStore";
import { SubagentsPanel } from "../components/chat/SubagentsPanel";
import { GitPanel } from "../components/git/GitPanel";
import { FilesPanel } from "../components/git/FilesPanel";

type CodeViewerSourceInput = Extract<
  NonNullable<ReturnType<typeof useAppStore.getState>["codeViewerSource"]>,
  { type: "file" | "text" | "patch" | "multi-file-diff" | "subagents" | "git" | "files" }
>;

function buildSource(
  input: Exclude<NonNullable<CodeViewerSourceInput>, { type: "subagents" | "git" | "files" }>,
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

  if (!codeViewerSource) {
    return null;
  }

  // Git 面板（P2-D）：分支/变更/提交历史，不走 PreviewPane。
  if (codeViewerSource.type === "git") {
    return (
      <div className="flex h-full w-[460px] flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]">
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
      <div className="flex h-full w-[460px] flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]">
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
      <div className="flex h-full w-[460px] flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]">
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
          <SubagentsPanel focusId={codeViewerSource.focusId} />
        </div>
      </div>
    );
  }

  const isPatch = codeViewerSource.type === "patch";

  return (
    <div className="flex h-full w-[460px] flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]">
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
