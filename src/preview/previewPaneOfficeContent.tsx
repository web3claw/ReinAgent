/**
 * Office 预览内容宿主 stub —— 渲染引擎（docx-preview / @extend-ai）未移植（阶段 1 范围外）。
 * 激活时如实显示「不可用」与真实错误，绝不伪造内容。
 */
import type { FileBinaryPreview } from "./shared";
import type { OfficeFilePreviewKind } from "./lib/officeFilePreview";

export function PreviewPaneOfficeContent(_props: {
  error?: unknown;
  kind: OfficeFilePreviewKind | null;
  loading: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  preview: FileBinaryPreview | null;
  resolvedTheme?: string;
  sourcePath?: string;
}) {
  return (
    <div className="flex h-full items-center justify-center p-3 text-ui-base text-foreground-subtle">
      Office 预览在当前宿主中不可用
    </div>
  );
}
