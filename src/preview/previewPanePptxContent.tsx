/**
 * PPTX 预览内容宿主 stub —— 渲染引擎（@aiden0z/pptx-renderer）未移植（阶段 1 范围外）。
 * 激活时如实显示「不可用」，绝不伪造内容。
 */
import type { PptxPreviewViewerProps } from "./components/ui/pptx-preview-viewer";

export function PptxPreviewContent(_props: PptxPreviewViewerProps) {
  return (
    <div className="flex h-full items-center justify-center p-3 text-ui-base text-foreground-subtle">
      PPTX 预览在当前宿主中不可用
    </div>
  );
}
