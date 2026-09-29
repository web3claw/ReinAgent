/**
 * Office 预览内容宿主（P2-E，替换阶段 1 的不可用 stub）：
 * - docx → docx-preview 渲染分页 HTML；
 * - excel（xlsx/xlsm/xls）→ SheetJS 逐 sheet 转 HTML 表格；
 * - doc（legacy 二进制）→ 如实显示不支持（docx-preview 不解析 .doc）；
 * - 加载失败如实上抛错误（No-Fallback）。
 * 数据来自 PreviewPane 的 FileBinaryPreview（base64 → ArrayBuffer）。
 */
import { useEffect, useMemo, useState } from "react";
import { renderAsync } from "docx-preview";
import * as XLSX from "xlsx";
import type { FileBinaryPreview } from "./shared";
import type { OfficeFilePreviewKind } from "./lib/officeFilePreview";

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function PreviewPaneOfficeContent({
  kind,
  loading,
  preview,
  sourcePath,
}: {
  error?: unknown;
  kind: OfficeFilePreviewKind | null;
  loading: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  preview: FileBinaryPreview | null;
  resolvedTheme?: string;
  sourcePath?: string;
}) {
  const [docxError, setDocxError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);

  const isDocx = kind === "docx";
  const isExcel = kind === "excel";

  // docx：base64 → renderAsync 到容器
  useEffect(() => {
    if (!isDocx || !preview) return;
    let cancelled = false;
    setDocxError(null);
    const container = document.getElementById("office-docx-container");
    if (!container) return;
    container.innerHTML = "";
    (async () => {
      try {
        const buffer = base64ToArrayBuffer(preview.dataBase64);
        await renderAsync(buffer, container, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          breakPages: true,
          useBase64URL: true,
        });
        if (!cancelled) setSheets(null);
      } catch (err) {
        if (!cancelled) setDocxError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDocx, preview]);

  // excel：SheetJS 解析 → 逐 sheet HTML
  useEffect(() => {
    if (!isExcel || !preview) return;
    let cancelled = false;
    try {
      const workbook = XLSX.read(base64ToArrayBuffer(preview.dataBase64), { type: "array" });
      const htmls = workbook.SheetNames.map((name) => ({
        name,
        html: XLSX.utils.sheet_to_html(workbook.Sheets[name]),
      }));
      if (!cancelled) {
        setSheets(htmls);
        setSheetIndex(0);
        setDocxError(null);
      }
    } catch (err) {
      if (!cancelled) setDocxError(String(err));
    }
    return () => {
      cancelled = true;
    };
  }, [isExcel, preview]);

  const containerClass = useMemo(
    () =>
      "office-preview-scroll h-full overflow-auto bg-[var(--bg)] p-4 " +
      (isExcel ? "office-excel-body" : "office-docx-body"),
    [isExcel],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--text-dim)]">
        加载中…
      </div>
    );
  }

  if (kind === "doc") {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-[var(--text-dim)]">
        legacy .doc（二进制格式）暂不支持预览——请用 Word 另存为 .docx 后再试。
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--text-dim)]">
        无预览数据
      </div>
    );
  }

  if (docxError) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="max-w-md break-all rounded-lg border border-[var(--danger)] p-3 text-xs text-[var(--danger)]">
          {sourcePath ? <div className="mb-1 font-mono">{sourcePath}</div> : null}
          {docxError}
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass}>
      {isExcel && sheets && sheets.length > 0 ? (
        <>
          {sheets.length > 1 ? (
            <div className="mb-2 flex flex-wrap gap-1">
              {sheets.map((sheet, index) => (
                <button
                  key={sheet.name}
                  type="button"
                  onClick={() => setSheetIndex(index)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    index === sheetIndex
                      ? "bg-[var(--accent)] text-white"
                      : "border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
                  }`}
                >
                  {sheet.name}
                </button>
              ))}
            </div>
          ) : null}
          <div
            className="office-excel-sheet"
            // SheetJS sheet_to_html 产出受控表格式 HTML（无脚本）
            dangerouslySetInnerHTML={{ __html: sheets[sheetIndex]?.html ?? "" }}
          />
        </>
      ) : null}
      {isDocx ? <div id="office-docx-container" /> : null}
      {isExcel && !sheets ? <p className="text-sm text-[var(--text-dim)]">解析中…</p> : null}
    </div>
  );
}
