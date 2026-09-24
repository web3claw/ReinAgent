import { useMemo } from "react";
import { DiffViewer } from "./components/ui/diff-viewer";
import { HighlightedLightweightDiffPreview } from "./components/ui/highlighted-lightweight-diff-preview";
import { inferCodeLanguage } from "./lib/codeViewer";
import { getPlainTextPatchFallbackLines } from "./lib/patchDiffPreview";
import type { CodePreviewSettings } from "./lib/codePreviewSettings";

interface PatchFallbackContentProps {
  patch: string;
  codePreviewSettings: CodePreviewSettings;
  resolvedTheme: "light" | "dark";
  sourcePath?: string;
  sourceTitle?: string;
}

export function PatchFallbackContent({
  patch,
  codePreviewSettings,
  resolvedTheme,
  sourcePath,
  sourceTitle,
}: PatchFallbackContentProps) {
  // 宿主兜底：@pierre 解析失败（或对生成 patch 格式过严）时直接按行拆分，
  // 保证 diff 内容永远可渲染（No-Fallback：不丢内容）。
  const plainTextFallbackLines = useMemo(
    () => getPlainTextPatchFallbackLines(patch) ?? patch.split(/\r?\n/),
    [patch]
  );
  const highlightPath = sourcePath ?? sourceTitle;
  const highlightLanguage = useMemo(
    () => inferCodeLanguage(highlightPath, patch),
    [highlightPath, patch],
  );
  const highlightTheme =
    resolvedTheme === "dark" ? codePreviewSettings.darkTheme : codePreviewSettings.lightTheme;

  if (plainTextFallbackLines) {
    // @pierre/diffs 的 PatchDiff 只支持单文件 patch。日志里出现过多文件
    // patch 直接进入右侧预览，生产包渲染阶段会抛错并卡住侧栏，所以这里统一降级成轻量 diff。
    // edit 打开的右侧 Diff 对新增/删除文件也会走这条轻量 fallback；之前只渲染纯文本，
    // 导致 HTML/TS 等文件在右侧失去语法高亮。这里复用异步 Shiki 高亮，保留不卡顿的轻量渲染路径。
    return (
      <HighlightedLightweightDiffPreview
        className="h-full"
        codePreviewSettings={codePreviewSettings}
        data-patch-plain-text-preview
        language={highlightLanguage}
        lines={plainTextFallbackLines}
        path={highlightPath}
        theme={highlightTheme}
      />
    );
  }

  return (
    <DiffViewer
      patch={patch}
      diffClassName="block"
      fontSizePx={codePreviewSettings.fontSizePx}
      lightTheme={codePreviewSettings.lightTheme}
      darkTheme={codePreviewSettings.darkTheme}
      themeType={resolvedTheme}
    />
  );
}
