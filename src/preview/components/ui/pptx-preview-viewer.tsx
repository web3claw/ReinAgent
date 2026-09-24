/**
 * PptxPreviewViewer 宿主 stub —— 宿主未引入 @aiden0z/pptx-renderer（阶段 1 范围外）。
 * PPTX 模式激活时如实显示「不可用」，绝不伪造内容。
 */
export interface PptxPreviewViewerLabels {
  loading: string;
  loadError: string;
  noSlides: string;
  previousPage: string;
  nextPage: string;
  pageInput: string;
  zoomIn: string;
  zoomOut: string;
  thumbnails: string;
  thumbnail: (pageNumber: number) => string;
  exportPdf: string;
  exportingPdf: string;
  exportPdfSuccess: (path: string) => string;
  exportPdfFailed: string;
  selectElement: string;
  exitElementSelection: string;
  aiEdit: string;
  commentPlaceholder: string;
  cancelAiEdit: string;
  addToConversation: string;
  referencedPageMissing: (pageNumber: number) => string;
  referencedSourceChanged: (pageNumber: number) => string;
}

export type PptxPreviewViewerProps = {
  data: ArrayBuffer | null;
  labels: PptxPreviewViewerLabels;
  fileName?: string;
  onOpenBrowserUrl?: (url: string) => void;
  referenceSource?: unknown;
  referenceNavigation?: unknown;
  referenceNavigationReady?: boolean;
};

export function PptxPreviewViewer(_props: PptxPreviewViewerProps) {
  return null;
}
