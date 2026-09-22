import { useEffect, useRef } from "react";
import type { TimelineEntry } from "../../lib/chat/conversationModel";
import { MessageItem } from "./MessageItem";

/** 距底部小于此像素视为「贴着底部」，此时才自动跟随流式滞底。 */
const STICK_TO_BOTTOM_PX = 120;

export interface MessageListProps {
  messages: TimelineEntry[];
  onEditSend?: (newText: string) => void;
}

/** 消息列表。新内容到达且用户本就贴在底部附近时自动滞底（S2 不引入虚拟滚动）。 */
export function MessageList({ messages, onEditSend }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastText = last?.text ?? "";
  const lastThinking = last?.thinking ?? "";

  // ★ S7-6 修的滚动缺陷：
  //   工具条目在 running → done/error 时**会长高**（resultText 出现），
  //   但它的 `length` / `text` / `thinking` 全都没变（工具条目 text/thinking 恒为空串）。
  //   若依赖数组里没有「工具状态派生量」，这一次长高就**不会触发滚动** ——
  //   新出现的结果会停在折叠区下方，用户看不见。
  //   为此把最后一条（工具条目）的状态 / 结果长度 / 是否出错拼成一个字符串并入依赖：
  //   任一变化都会让本效应重新执行，从而把结果滚进视野。
  const lastToolSignal =
    last && last.role === "tool"
      ? `${last.status}:${(last.resultText ?? "").length}:${last.isError ? 1 : 0}`
      : "";

  // 用户是否意图保持跟随底部（默认开启）
  const isFollowingRef = useRef(true);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const scrollParent = (list.closest('.overflow-y-auto') as HTMLElement | null) || list;

    const handleScroll = () => {
      const distanceToBottom = scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight;
      // 当距离底部小于阈值时，认为用户回到最新内容并重新锁定跟随；若用户大幅上滑则暂停吸底
      isFollowingRef.current = distanceToBottom <= STICK_TO_BOTTOM_PX;
    };

    scrollParent.addEventListener("scroll", handleScroll, { passive: true });

    // 用 ResizeObserver 监听内容实际高度变化（Markdown 渲染、代码块展开、工具高度增加）
    const observer = new ResizeObserver(() => {
      if (isFollowingRef.current) {
        scrollParent.scrollTop = scrollParent.scrollHeight;
      }
    });

    observer.observe(list);

    // 初始或新消息到达时立即吸底
    if (isFollowingRef.current) {
      scrollParent.scrollTop = scrollParent.scrollHeight;
    }

    return () => {
      scrollParent.removeEventListener("scroll", handleScroll);
      observer.disconnect();
    };
  }, [messages.length, lastText, lastThinking, lastToolSignal]);

  return (
    <div className="message-list" ref={listRef}>
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} onEditSend={onEditSend} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
