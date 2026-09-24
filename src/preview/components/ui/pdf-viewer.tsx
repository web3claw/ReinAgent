/**
 * PdfViewer 宿主 stub —— 宿主未引入 react-pdf/pdfjs（阶段 1 范围外）。
 * PDF 模式激活时如实显示「不可用」，绝不伪造内容。
 */
export interface PdfViewerLabels {
  loading: string;
  loadError: string;
  noData: string;
  previousPage: string;
  nextPage: string;
  pageInput: string;
  zoomIn: string;
  zoomOut: string;
}

export type PdfViewerSource =
  | string
  | Uint8Array
  | {
      totalBytes: number;
      requestRange: (offset: number, length: number) => Promise<Uint8Array>;
    };

export function PdfViewer(_props: { source?: PdfViewerSource; labels?: PdfViewerLabels }) {
  return null;
}
