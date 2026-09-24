/**
 * IntlProvider 适配层 —— 替代 ZCode 的 i18n 体系。
 * useZCodeIntl() 返回 { intl: { formatMessage } }，闭包内所有预览组件经此取文案。
 * 字典缺失的 id 如实回退为 id 本身（不伪造文案）。
 */
import { useMemo } from "react";
import { useAppStore } from "../../store/useAppStore";

type MessageValues = Record<string, string | number>;

const zhMessages: Record<string, string> = {
  "appHeader.openInFileManagerFailed": "打开文件管理器失败",
  "chat.changeSummary.openInEditor": "在编辑器打开",
  "codeViewer.binary": "二进制文件，无法预览",
  "codeViewer.comment.add": "添加评论",
  "codeViewer.comment.delete": "删除评论",
  "codeViewer.comment.line": "行",
  "codeViewer.comment.range": "范围",
  "codeViewer.comment.submit": "提交",
  "codeViewer.empty": "文件为空",
  "codeViewer.fileMissing": "文件不存在或已被移动",
  "codeViewer.fileTooLarge": "文件过大，仅支持预览前 256KB",
  "codeViewer.imageUnavailable": "图片预览不可用",
  "codeViewer.loadingFile": "正在加载文件…",
  "codeViewer.loadingImage": "正在加载图片…",
  "codeViewer.loadingMedia": "正在加载媒体…",
  "codeViewer.loadingPdf": "正在加载 PDF…",
  "codeViewer.loadingPptx": "正在加载 PPTX…",
  "codeViewer.markdownMode": "渲染",
  "codeViewer.mediaLoadFailed": "媒体加载失败",
  "codeViewer.mediaUnavailable": "媒体预览不可用",
  "codeViewer.mediaUnsupported": "不支持预览该媒体类型",
  "codeViewer.officeTooLarge": "Office 文件过大",
  "codeViewer.pdfUnavailable": "PDF 预览不可用",
  "codeViewer.review.targetLineMissing": "目标行不在预览范围内",
  "codeViewer.svgMode": "SVG 预览",
  "codeViewer.svgPreview": "预览",
  "codeViewer.svgSource": "源码",
  "codeViewer.wrapLines": "自动换行",
  "common.cancel": "取消",
  "common.more": "更多",
  "fileActions.copyAbsolutePath": "复制绝对路径",
  "fileActions.copyRelativePath": "复制相对路径",
};

const enMessages: Record<string, string> = {
  "appHeader.openInFileManagerFailed": "Failed to open file manager",
  "chat.changeSummary.openInEditor": "Open in editor",
  "codeViewer.binary": "Binary file, preview unavailable",
  "codeViewer.comment.add": "Add comment",
  "codeViewer.comment.delete": "Delete comment",
  "codeViewer.comment.line": "Line",
  "codeViewer.comment.range": "Range",
  "codeViewer.comment.submit": "Submit",
  "codeViewer.empty": "File is empty",
  "codeViewer.fileMissing": "File is missing or has been moved",
  "codeViewer.fileTooLarge": "File too large, only the first 256KB can be previewed",
  "codeViewer.imageUnavailable": "Image preview unavailable",
  "codeViewer.loadingFile": "Loading file…",
  "codeViewer.loadingImage": "Loading image…",
  "codeViewer.loadingMedia": "Loading media…",
  "codeViewer.loadingPdf": "Loading PDF…",
  "codeViewer.loadingPptx": "Loading PPTX…",
  "codeViewer.markdownMode": "Rendered",
  "codeViewer.mediaLoadFailed": "Failed to load media",
  "codeViewer.mediaUnavailable": "Media preview unavailable",
  "codeViewer.mediaUnsupported": "This media type cannot be previewed",
  "codeViewer.officeTooLarge": "Office file too large",
  "codeViewer.pdfUnavailable": "PDF preview unavailable",
  "codeViewer.review.targetLineMissing": "Target line is out of preview range",
  "codeViewer.svgMode": "SVG preview",
  "codeViewer.svgPreview": "Preview",
  "codeViewer.svgSource": "Source",
  "codeViewer.wrapLines": "Wrap lines",
  "common.cancel": "Cancel",
  "common.more": "More",
  "fileActions.copyAbsolutePath": "Copy absolute path",
  "fileActions.copyRelativePath": "Copy relative path",
};

const dictionaries: Record<string, Record<string, string>> = {
  "zh-CN": zhMessages,
  "en-US": enMessages,
};

function format(template: string, values?: MessageValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match
  );
}

export function useZCodeIntl() {
  const locale = useAppStore((state) => state.locale);
  const localeKey = locale === "en-US" ? "en-US" : "zh-CN";
  const intl = useMemo(
    () => ({
      locale: localeKey,
      formatMessage: (
        descriptor: { id: string },
        values?: MessageValues
      ): string => {
        const dictionary = dictionaries[localeKey] ?? zhMessages;
        const template = dictionary[descriptor.id] ?? descriptor.id;
        return format(template, values);
      },
    }),
    [localeKey]
  );
  return { intl };
}
