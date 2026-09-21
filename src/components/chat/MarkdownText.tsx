import { Component, memo } from "react";
import type { ReactNode } from "react";
import { MarkdownBlocks } from "../../lib/markdown/markdownBlocks";

/**
 * MarkdownText —— 助手消息的 Markdown 渲染（S5，S6 性能优化）。
 *
 * 安全（硬要求）：
 *   只启用 `remark-gfm`（GFM 扩展：表格/删除线/任务列表/自动链接）—— 该插件在
 *   `markdownBlocks` 内部统一启用。**绝不启用 `rehype-raw` 或任何 rehype HTML 插件**，
 *   因此 react-markdown 的默认行为成立：模型输出中的原始 HTML 会被**忽略/转义**，
 *   不会被当作 DOM 注入。模型输出属于不可信内容，这是防 XSS 的关键，勿改动。
 *
 * 流式稳定性（难点）：
 *   流式过程中会不断出现**未闭合**的 ``` 代码围栏、未闭合的 `**`、半截表格等。
 *   处理方式：
 *     1. 不把不完整语法当错误 —— react-markdown/remark 对半成品 Markdown 是容错的
 *        （未闭合围栏会把其后内容当作代码块，不会抛错）；
 *     2. `MarkdownErrorBoundary` 兜底 —— 万一任何解析/渲染异常，退回纯文本，
 *        绝不让半成品把界面打崩；
 *     3. `React.memo`（比较 text）—— 只有当前流式消息的 text 会变，
 *        历史消息不重解析，避免整段重排/闪烁；
 *     4. 不做 debounce/节流 —— 每个 text_delta 都即时渲染，不引入额外延迟，
 *        不破坏打字机效果。
 *
 * S6 性能优化（见 `src/lib/markdown/markdownBlocks.js` 的 `MarkdownBlocks`）：
 *   原先每个 delta 都把**整篇**重解析（O(N × 全文)）。现在改为**块级渲染**：
 *   整篇先切成顶层块，每块独立 `memo`；流式时只有**最后一块**在变 → 每个 delta
 *   只重解析最后一块。收益来自**记忆化**（非节流），打字机效果不受影响。
 *   超长文本（> 预算）先渲染前若干块，并提供「展开全文 / 收起」按钮。
 */

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
    // 记录但不外抛：半成品 Markdown 引发的异常不应中断渲染。
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
      <MarkdownBlocks text={text} />
    </MarkdownErrorBoundary>
  );
}

/** 仅当 text 变化时才重新解析 Markdown。 */
export const MarkdownText = memo(MarkdownTextImpl, (prev, next) => prev.text === next.text);
