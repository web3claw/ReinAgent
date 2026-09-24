/**
 * Markdown 预览内容 —— 宿主适配版。
 * ZCode 原实现用 streamdown/mermaid 渲染流式 Markdown；宿主复用自有的 MarkdownText
 * （静态 Markdown 渲染，已带 memo），选区/浏览器打开等增强能力暂不接线。
 */
import { MarkdownText } from "../components/chat/MarkdownText";

export function MarkdownPreviewContent(props: {
  selectionTarget?: unknown;
  sourceKey: string;
  sourceTitle?: string;
  sourcePath?: string;
  content: string;
  workspacePath?: string;
  theme?: string;
  codePreviewSettings?: unknown;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  return (
    <div className="h-full overflow-auto p-3">
      <div className="md text-sm">
        <MarkdownText text={props.content} />
      </div>
    </div>
  );
}
