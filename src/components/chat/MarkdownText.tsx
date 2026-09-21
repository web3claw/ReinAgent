import { Component, memo } from "react";
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

function MarkdownTextImpl({ text }: { text: string }) {
  return (
    <MarkdownErrorBoundary fallback={<span className="msg-text">{text}</span>}>
      <MarkdownBlocks text={text} renderBlock={MarkdownBlockRenderer} />
    </MarkdownErrorBoundary>
  );
}

/** 仅当 text 变化时才重新解析 Markdown。 */
export const MarkdownText = memo(MarkdownTextImpl, (prev, next) => prev.text === next.text);
