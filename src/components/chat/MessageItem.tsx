import { memo } from "react";
import type { TimelineEntry, ToolTimelineEntry } from "../../lib/chat/conversationModel";
import { MarkdownText } from "./MarkdownText";
import { ToolCallCard } from "./ToolCallCard";

/**
 * 类型收窄守卫：把工具条目从联合类型里挑出来。
 *
 * 为什么需要它（而不是直接写 `message.role === "tool"`）：
 *   `ChatMessage.role` 的类型被 S7 放宽为 `TimelineRole`（含 "tool"），
 *   所以仅凭 `message.role === "tool"` **无法**把 `ChatMessage | ToolTimelineEntry`
 *   收窄到 `ToolTimelineEntry` —— TS 会保留 `ChatMessage` 这一支，于是传给
 *   `ToolCallCard` 时会报「缺少 toolCallId / resultText 等必填字段」。
 *   用 `is` 谓词显式收窄即可。
 */
function isToolEntry(message: TimelineEntry): message is ToolTimelineEntry {
  return message.role === "tool";
}

/**
 * 单条消息：用户（纯文本，保留换行）或助手（Markdown 渲染）。
 * 助手消息支持：流式光标、错误提示、以及 S4 的「已停止」标注。
 *
 * S7-6：工具条目在此**最先分流** —— 否则它会落进助手分支，
 * 被渲染成一个空的「ReinAgent」气泡。
 */
function MessageItemImpl({ message }: { message: TimelineEntry }) {
  if (isToolEntry(message)) {
    return <ToolCallCard entry={message} />;
  }

  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";

  return (
    <div className={`msg ${isUser ? "msg-user" : "msg-assistant"}`}>
      <div className="msg-role">{isUser ? "你" : "ReinAgent"}</div>
      <div className="msg-body">
        {isUser ? (
          <span className="msg-text">{message.text}</span>
        ) : (
          <div className="md">
            <MarkdownText text={message.text} />
            {isStreaming ? <span className="msg-caret">▋</span> : null}
          </div>
        )}

        {message.status === "stopped" ? <div className="msg-stopped">已停止</div> : null}
        {/* S7：步数硬闸触顶的可见终止说明（纯展示字段，不改 status）。 */}
        {message.truncatedBy === "maxSteps" ? (
          <div className="msg-max-steps">已达最大步数，本次回复已停止。</div>
        ) : null}
        {message.status === "error" ? (
          <div className="msg-error">出错了：{message.error ?? "未知错误"}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 包一层 `memo`：流式期间 `MessageList` 每个 delta 都会重渲染（messages 数组是新的），
 * 但状态机里**只有发生变化的那一条**条目会得到新对象引用，其余条目引用稳定。
 * 默认浅比较即可跳过未变条目（尤其无内部 memo 的用户消息），省掉长会话下的白烧渲染。
 */
export const MessageItem = memo(MessageItemImpl);
