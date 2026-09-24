import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelineEntry } from "../../lib/chat/conversationModel";
import { groupTurns } from "../../lib/chat/turnActivity";
import { TurnGroupView } from "./TurnGroupView";

/** 距底部小于此像素视为「贴着底部」，此时才自动跟随流式滞底。 */
const STICK_TO_BOTTOM_PX = 120;

export interface MessageListProps {
  messages: TimelineEntry[];
  /** Agent 循环是否仍在流式（用于把最后一轮钉在「工作中」，消除轮间空窗闪烁）。 */
  isStreaming?: boolean;
  /** 会话工作区根目录（传给文件更改摘要卡的临时目录清理）。 */
  workspaceRoot?: string;
  onEditSend?: (newText: string) => void;
  onRetry?: () => void;
}

/** 消息列表。新内容到达且用户本就贴在底部附近时自动滞底（S2 不引入虚拟滚动）。 */
export function MessageList({ messages, isStreaming = false, workspaceRoot, onEditSend, onRetry }: MessageListProps) {
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

  // 按用户提问切轮渲染；运行中轮的工时由每秒 live tick 驱动（对齐 ZCode，不用 rAF）。
  const turns = useMemo(() => groupTurns(messages), [messages]);
  const hasRunningTurn = isStreaming || turns.some((turn) => turn.running);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunningTurn) return;
    const timer = window.setInterval(() => setLiveNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningTurn]);

  return (
    <div className="message-list" ref={listRef}>
      {turns.map((turn, index) => (
        <TurnGroupView
          key={turn.key}
          group={turn}
          live={isStreaming && index === turns.length - 1}
          liveNowMs={liveNowMs}
          workspaceRoot={workspaceRoot}
          onEditSend={onEditSend}
          onRetry={onRetry}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}
