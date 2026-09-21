import { memo } from "react";
import type { ToolTimelineEntry } from "../../lib/chat/conversationModel";
import { formatToolArgs } from "../../lib/chat/toolDisplay";

/**
 * ToolCallCard —— 一次工具调用的展示卡片（S7-6）。
 *
 * 定位：它是「过程」而不是「对话」。因此视觉上刻意区别于助手/用户气泡
 * （更窄、左缩进、小字号、次级底色）—— 见 global.css「工具调用卡片（S7）」分节。
 *
 * 设计取舍：
 *   - 结果区用**原生 `<details>`**，不引入任何组件状态：这是纯展示，
 *     `useState` 只会让流式期间的高频重渲染更贵。
 *   - 包一层 `React.memo`：列表在流式期间每个 delta 都会重渲染，卡片小而多，
 *     包一层是便宜的保险（条目对象在状态机里是「只改变化的那条」，身份稳定）。
 *   - 不渲染 emoji（项目规范）；`✓` / `✕` / `◌` 这类排版符号可用。
 */

/** 状态 → 标记 + 中文文案。 */
function statusView(status: ToolTimelineEntry["status"]): { mark: string; label: string } {
  switch (status) {
    case "running":
      return { mark: "◌", label: "正在调用" };
    case "error":
      return { mark: "✕", label: "调用失败" };
    case "done":
    default:
      return { mark: "✓", label: "已调用" };
  }
}

function ToolCallCardImpl({ entry }: { entry: ToolTimelineEntry }) {
  const { mark, label } = statusView(entry.status);
  const isRunning = entry.status === "running";
  const isError = Boolean(entry.isError);
  const argsText = formatToolArgs(entry.args);
  const hasResult = typeof entry.resultText === "string" && entry.resultText.length > 0;

  return (
    <div
      className="tool-card"
      data-status={entry.status}
      role="group"
      aria-label={`工具调用：${entry.toolName}`}
      aria-busy={isRunning ? true : undefined}
    >
      <div className="tool-head">
        <span className="tool-mark" aria-hidden="true">
          {mark}
        </span>
        <span className="tool-status">{label}</span>
        <span className="tool-name">{entry.toolName}</span>
      </div>

      {argsText ? (
        <div className="tool-args" title={argsText}>
          {argsText}
        </div>
      ) : null}

      {isRunning && !hasResult ? (
        // running 且尚无结果：不渲染 <details>。
        // 理由：此时折叠框里本就没有内容，点开它只是一次无收益的交互；
        // 一行「执行中…」既表意又不会凭空多出一个空的折叠控件。
        <div className="tool-pending">执行中…</div>
      ) : (
        // error 默认展开：失败信息是用户最需要立刻看到的，不该藏在一次点击后面。
        // done 默认收起（open 为 false）。
        <details className="tool-details" open={isError}>
          <summary>结果</summary>
          <pre className="tool-result">{entry.resultText}</pre>
        </details>
      )}
    </div>
  );
}

/** 仅当条目变化时才重渲染（默认浅比较即可：props 只有 entry）。 */
export const ToolCallCard = memo(ToolCallCardImpl);
