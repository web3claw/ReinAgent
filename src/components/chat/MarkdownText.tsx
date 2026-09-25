import { Component, memo, useCallback } from "react";
import type { ReactNode } from "react";
import { MarkdownBlocks } from "../../lib/markdown/markdownBlocks";
import { MarkdownBlockRenderer } from "./MarkdownBlockRenderer";

/** 兜底错误边界：任何渲染异常 → 退回等宽纯文本。 */
class MarkdownErrorBoundary extends Component<{ fallback: ReactNode; children?: ReactNode }, { failed: boolean }> {
  constructor(props: { fallback: ReactNode; children?: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn("[markdown] 渲染失败，已退回纯文本：", error);
  }

  render(): ReactNode {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

function MarkdownTextImpl({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // streaming 透传到块渲染器：流式中的代码块跳过 Shiki 高亮（对齐 ZCode：
  // 高亮等消息完成后再启动，避免 async highlighter 与消息流更新叠加造成卡顿）。
  const renderBlock = useCallback(
    ({ text: blockText }: { text: string }) => (
      <MarkdownBlockRenderer text={blockText} streaming={streaming} />
    ),
    [streaming],
  );
  return (
    <MarkdownErrorBoundary fallback={<span className="msg-text">{text}</span>}>
      <MarkdownBlocks text={text} renderBlock={renderBlock} />
    </MarkdownErrorBoundary>
  );
}

/** 仅当 text 变化时才重新解析 Markdown。 */
export const MarkdownText = memo(
  MarkdownTextImpl,
  (prev, next) => prev.text === next.text && prev.streaming === next.streaming,
);
