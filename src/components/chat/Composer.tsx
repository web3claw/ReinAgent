import { useState } from "react";

/**
 * 输入框 + 发送/停止按钮。
 * S4：生成中「停止」真正可点，接入 AbortController（由 useConversation.stop 提供）。
 *
 * 输入保留不丢（A-1）：`onSend` 返回「本次是否被受理」。**仅在被受理时才清空输入框**，
 * 这样即使出现「状态已 idle 但编排器尚未就绪」一类的竞态窗口，用户输入也留在框里，
 * 不会被无声吞掉。
 */
export function Composer({
  isStreaming,
  onSend,
  onStop,
}: {
  isStreaming: boolean;
  onSend: (text: string) => boolean;
  onStop: () => void;
}) {
  const [text, setText] = useState("");

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || isStreaming) return;
    if (onSend(trimmed)) setText("");
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        className="composer-input"
        rows={2}
        value={text}
        placeholder="输入消息，Enter 发送，Shift+Enter 换行"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {isStreaming ? (
        <button type="button" className="btn btn-stop" onClick={onStop}>
          停止
        </button>
      ) : (
        <button type="submit" className="btn" disabled={text.trim().length === 0}>
          发送
        </button>
      )}
    </form>
  );
}
