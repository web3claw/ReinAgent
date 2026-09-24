/**
 * PDF 预览内容宿主 stub —— 渲染引擎（react-pdf/pdfjs）未移植（阶段 1 范围外）。
 * 激活时如实显示「不可用」，绝不伪造内容。
 */
import type { PdfViewerLabels, PdfViewerSource } from "./components/ui/pdf-viewer";

export function PdfPreviewContent(_props: {
  source: PdfViewerSource | null;
  labels: PdfViewerLabels;
}) {
  return (
    <div className="flex h-full items-center justify-center p-3 text-ui-base text-foreground-subtle">
      PDF 预览在当前宿主中不可用
    </div>
  );
}
