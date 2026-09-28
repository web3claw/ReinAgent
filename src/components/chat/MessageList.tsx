import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { TimelineEntry } from "../../lib/chat/conversationModel";
import { groupTurns, type TurnGroup } from "../../lib/chat/turnActivity";
import { TurnGroupView } from "./TurnGroupView";

/** 距底部小于此像素视为「贴着底部」，此时才自动跟随流式滞底。 */
const STICK_TO_BOTTOM_PX = 120;
/** 虚拟化 overscan（上下各多渲染的轮数，对齐 ZCode ROW_OVERSCAN）。 */
const TURN_OVERSCAN = 4;
/** 未测量轮的估算高度（对齐 ZCode estimateSize 兜底）。 */
const DEFAULT_TURN_HEIGHT = 220;
/** 流式 delta 通知节流（对齐 ZCode flushWindowMs=30）由池层负责；此处常量仅注释引用。 */

/**
 * 轮高度 LRU 缓存（对齐 ZCode timelineRowHeightCache）：
 * 解决「虚拟化重建/重挂时把测高清回 estimateSize 导致滚动条跳动」。
 */
class TurnHeightCache {
  private map = new Map<string, number>();
  constructor(private readonly limit: number) {}
  get(key: string): number | undefined {
    const hit = this.map.get(key);
    if (hit !== undefined) {
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }
  set(key: string, height: number) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, height);
    if (this.map.size > this.limit) {
      this.map.delete(this.map.keys().next().value as string);
    }
  }
}
const heightCache = new TurnHeightCache(4000);

/**
 * 轮偏移注册表：turnKey -> 相对滚动容器内容顶部的偏移。
 * 虚拟化下屏外轮未挂载，导航条 DOM 查询会失败，从这里兜底查询
 * （值随虚拟化测量/滚动边距变化持续刷新）。
 */
const turnOffsetRegistry = new Map<string, number>();

/** 导航条兜底查询：msgId（= 轮首用户消息 id）对应的近似偏移。 */
export function getRegisteredTurnOffset(msgId: string): number | undefined {
  return turnOffsetRegistry.get(msgId);
}

export interface MessageListProps {
  messages: TimelineEntry[];
  /** Agent 循环是否仍在流式（用于把最后一轮钉在「工作中」，消除轮间空窗闪烁）。 */
  isStreaming?: boolean;
  /** 自动重试记录（当前轮；来自 state.retryAttempts，重试详情块数据源） */
  retryAttempts?: import("../../lib/chat/conversationModel").RetryAttemptRecord[];
  /** 是否处于自动重试等待期（重连副行显示条件；新尝试开始即撤下）。 */
  retrying?: boolean;
  /** 会话工作区根目录（传给文件更改摘要卡的临时目录清理）。 */
  workspaceRoot?: string;
  /** 外部定位请求（搜索跳转）：目标消息 id；滚动完成后回调置空。 */
  scrollTargetMessageId?: string | null;
  onScrollTargetDone?: () => void;
  /** 滚动容器（App 的 chatScrollRef；MessageList 内容是其子节点）。 */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /**
   * 滚动容器元素（state 持有）：虚拟列表的 getScrollElement 数据源。
   * 用 state 而非 ref 采样——元素挂载必然伴随一次渲染，规避「虚拟器在 ref 接上
   * 之前采样到 null 后永久停摆（容器有估高、行数 0）」的首点竞态。
   */
  scrollEl?: HTMLDivElement | null;
  onEditSend?: (newText: string) => void;
  /** 编辑重发（硬截断；异步执行，失败时原历史保持不变）。 */
  onEditResend?: (messageId: string, text: string, attachments: import("../../lib/chat/attachments").UserAttachmentRef[]) => void;
  /** 以原始提问重发该轮。 */
  onRetryFrom?: (messageId: string) => void;
  /** 从某条回复创建分支（复制前缀进新任务并切换）。 */
  onBranchFrom?: (messageId: string) => void;
  /** 变化时强制恢复贴底跟随并置底（编辑重发/重试后对齐 LiveAgent stickToBottom）。 */
  followSignal?: number;
  /** 会话级挂起审批（透传实时轮：attention 态强制展开状态条）。 */
  pendingApproval?: unknown;
}

/**
 * 消息时间线（对齐 ZCode ConversationTimeline 的性能架构）：
 * - **虚拟化 + live tail 拆分**：已完成轮走 @tanstack/react-virtual 虚拟列表
 *   （按整轮为单位、稳定 turn key、overscan、行高 LRU 缓存），**正在流式的最后一轮
 *   拆出虚拟列表放普通文档流**——避免「流式长高 → 下一帧回填 → 滚动跳动」循环；
 * - **行级 memo**：groupTurns 结果做引用稳定化（entries 未变的轮复用旧对象），
 *   TurnGroupView memo 后流式时每帧只有正在流的轮重渲染；
 * - **滚动权状态机**：following 存 ref；wheel/touch/键盘在 capture 阶段预登记用户
 *   上滚意图（同帧解除跟随，不等 scroll 事件）；程序化贴底在时间窗内不参与跟随判定；
 *   贴底为 instant 直接赋值（禁 smooth），并禁用浏览器原生滚动锚定。
 */
export function MessageList({
  messages,
  isStreaming = false,
  workspaceRoot,
  retryAttempts,
  retrying = false,
  scrollRef,
  scrollEl,
  onEditSend,
  onEditResend,
  onRetryFrom,
  onBranchFrom,
  followSignal,
  pendingApproval,
  /** 外部定位请求（搜索跳转）：滚动到该消息 + 短暂高亮；滚动完成后置 null */
  scrollTargetMessageId,
  onScrollTargetDone,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // ---- 编辑态（对齐 LiveAgent 单值 editingMessageKey）：被编辑行随截断消失时自动退出 ----
  const [editingMessageKey, setEditingMessageKey] = useState<string | null>(null);
  useEffect(() => {
    if (!editingMessageKey) return;
    const stillThere = messages.some((m) => m.role === "user" && m.id === editingMessageKey);
    if (!stillThere) setEditingMessageKey(null);
  }, [editingMessageKey, messages]);
  const handleStartEdit = useCallback((key: string) => setEditingMessageKey(key), []);
  const handleCancelEdit = useCallback(() => setEditingMessageKey(null), []);

  // ---- 滚动权状态机：following 存 ref；用户上滚意图 capture 阶段同帧解除 ----
  const followingRef = useRef(true);
  const programmaticUntilRef = useRef(0);

  const stickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 程序化贴底标记：时间窗内的 scroll 事件不参与跟随判定（区分 user/programmatic 来源）
    programmaticUntilRef.current = Date.now() + 120;
    el.scrollTop = el.scrollHeight; // instant：smooth 的中间帧会被滚动判定误读为离底
  }, [scrollRef]);

  /** 编辑重发/重试截断重跑后：强制恢复贴底跟随（对齐 LiveAgent stickToBottom on run start）。 */
  useEffect(() => {
    if (followSignal === undefined || followSignal === 0) return;
    followingRef.current = true;
    stickToBottom();
  }, [followSignal, stickToBottom]);

  // ---- 搜索跳转定位：滚动到目标消息 + 高亮。消息行是轮内 DOM（虚拟化屏外轮未挂载），
  //      所以先确保目标轮在虚拟列表里渲染（scrollToIndex），再对 data-msg-id 锚点定位。----
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  useEffect(() => {
    if (!scrollTargetMessageId) return;
    const el = scrollRef.current;
    if (!el || scrollEl === null || scrollEl === undefined) return;
    // 找到目标消息所属轮（messages 平铺序 → groupTurns 的轮），拿轮下标驱动虚拟列表
    const msgIndex = messages.findIndex((m) => m.id === scrollTargetMessageId);
    if (msgIndex === -1) {
      onScrollTargetDone?.();
      return;
    }
    // 轮下标（liveTurn 不在虚拟列表里——正在流式的轮永远在底部可见）
    let turnIdx = historyTurns.findIndex(
      (turn) =>
        turn.userMessage?.id === scrollTargetMessageId ||
        turn.activity.some((a) => a.id === scrollTargetMessageId) ||
        turn.lastAssistant?.id === scrollTargetMessageId,
    );
    if (turnIdx >= 0) {
      // 先让虚拟列表渲染目标轮（即使估算高度不准，DOM 挂载后第二步再做像素级定位）
      virtualizer.scrollToIndex(turnIdx, { align: "start" });
    }
    // 两帧后（虚拟行已挂载）做像素级定位：锚点行距视口顶 16px（对齐导航条 JUMP_TOP_GAP）
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const node = el.querySelector(`[data-msg-id="${CSS.escape(scrollTargetMessageId)}"]`);
        if (node) {
          const target =
            el.scrollTop +
            (node as HTMLElement).getBoundingClientRect().top -
            el.getBoundingClientRect().top -
            16;
          programmaticUntilRef.current = Date.now() + 300;
          el.scrollTo({ top: Math.max(0, target), behavior: "auto" });
          followingRef.current = false;
          setHighlightMessageId(scrollTargetMessageId);
          window.setTimeout(() => setHighlightMessageId(null), 2400);
        }
        onScrollTargetDone?.();
      });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅按定位请求触发
  }, [scrollTargetMessageId]);

  // 用户上滚意图预登记（wheel / touch / 键盘，capture 阶段，不等 scroll 事件）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const unfollow = () => {
      followingRef.current = false;
    };
    let lastTouchY = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) unfollow();
    };
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > lastTouchY) unfollow(); // 手指下滑 = 内容上滚
      lastTouchY = y;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") unfollow();
    };
    el.addEventListener("wheel", onWheel, { passive: true, capture: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true, capture: true });
    el.addEventListener("keydown", onKey, { capture: true });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true });
      el.removeEventListener("touchstart", onTouchStart, { capture: true });
      el.removeEventListener("touchmove", onTouchMove, { capture: true });
      el.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [scrollRef]);

  // 滚动事件：仅用户来源（非程序化时间窗内）能改变跟随态
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (Date.now() < programmaticUntilRef.current) return;
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      followingRef.current = distanceToBottom <= STICK_TO_BOTTOM_PX;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [scrollRef]);

  // ---- groupTurns 结果引用稳定化：entries 未变的轮复用旧 group 对象（memo 生效前提）----
  const prevTurnsRef = useRef<TurnGroup[] | null>(null);
  const turns = useMemo(() => {
    const next = groupTurns(messages);
    const prev = prevTurnsRef.current;
    if (prev) {
      for (let i = 0; i < next.length && i < prev.length; i++) {
        const a = prev[i];
        const b = next[i];
        if (a.key !== b.key) continue;
        if (a.userMessage !== b.userMessage) continue;
        if (a.activity.length !== b.activity.length) continue;
        let same = true;
        for (let j = 0; j < b.activity.length; j++) {
          if (a.activity[j] !== b.activity[j]) {
            same = false;
            break;
          }
        }
        if (same && a.lastAssistant !== b.lastAssistant) same = false;
        if (same) next[i] = a;
      }
    }
    prevTurnsRef.current = next;
    return next;
  }, [messages]);

  const liveIndex = isStreaming && turns.length > 0 ? turns.length - 1 : -1;
  const liveTurn = liveIndex >= 0 ? turns[liveIndex] : null;
  const historyTurns = useMemo(
    () => (liveTurn ? turns.filter((t) => t !== liveTurn) : turns),
    [turns, liveTurn],
  );

  // ---- 虚拟化（已完成轮）----
  const virtualizer = useVirtualizer({
    count: historyTurns.length,
    getScrollElement: () => scrollEl ?? null,
    estimateSize: (index) => heightCache.get(historyTurns[index]?.key ?? "") ?? DEFAULT_TURN_HEIGHT,
    getItemKey: (index) => historyTurns[index]?.key ?? String(index),
    overscan: TURN_OVERSCAN,
    measureElement: (el) => {
      const height = el instanceof HTMLElement ? el.getBoundingClientRect().height : 0;
      const indexAttr = el?.getAttribute?.("data-index");
      const index = indexAttr !== null && indexAttr !== undefined ? Number(indexAttr) : Number.NaN;
      if (!Number.isNaN(index)) {
        const key = historyTurns[index]?.key;
        if (key) heightCache.set(key, height);
      }
      return height;
    },
  });

  // scrollMargin：虚拟列表起点相对滚动容器顶部的偏移（含 App 的内边距包装）
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    const listEl = listRef.current;
    if (!scrollEl || !listEl) return;
    const update = () => {
      const top =
        listEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
      setScrollMargin((cur) => (Math.abs(cur - top) > 0.5 ? top : cur));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(listEl);
    return () => ro.disconnect();
  }, [scrollRef]);

  // ---- 隐藏窗口停表（对齐 LiveAgent）：页面不可见期间不计入运行中轮的工时 ----
  // 全部隐藏时段记在 ref 里（乱序容忍由 effectiveWorkMs 处理），visibilitychange 维护开闭。
  const hiddenSpansRef = useRef<Array<[number, number]>>([]);
  useEffect(() => {
    const onVisibility = () => {
      const spans = hiddenSpansRef.current;
      if (document.visibilityState === "hidden") {
        spans.push([Date.now(), Number.POSITIVE_INFINITY]);
      } else {
        const last = spans[spans.length - 1];
        if (last && last[1] === Number.POSITIVE_INFINITY) last[1] = Date.now();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ---- live tick：只驱动正在流式的轮（历史轮不接收该 prop，避免全列表每秒重渲染）----
  const hasRunningTurn = isStreaming || turns.some((turn) => turn.running);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunningTurn) return;
    const timer = window.setInterval(() => setLiveNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningTurn]);

  // ---- 回调稳定化（App 每次渲染会新建回调；ref 包装保引用稳定）----
  const onEditSendRef = useRef(onEditSend);
  onEditSendRef.current = onEditSend;
  const onEditResendRef = useRef(onEditResend);
  onEditResendRef.current = onEditResend;
  const onRetryFromRef = useRef(onRetryFrom);
  onRetryFromRef.current = onRetryFrom;
  const onBranchFromRef = useRef(onBranchFrom);
  onBranchFromRef.current = onBranchFrom;
  const stableEditSend = useCallback((text: string) => onEditSendRef.current?.(text), []);
  const stableEditResend = useCallback(
    (messageId: string, text: string, attachments: import("../../lib/chat/attachments").UserAttachmentRef[]) => {
      onEditResendRef.current?.(messageId, text, attachments);
    },
    [],
  );
  const stableRetryFrom = useCallback((messageId: string) => onRetryFromRef.current?.(messageId), []);
  const stableBranchFrom = useCallback((messageId: string) => onBranchFromRef.current?.(messageId), []);

  // 内容高度变化（live tail 流式长高）且仍跟随 → 贴底（instant）。
  // RO 常驻不随 delta 重挂：内容增长本身就会触发 RO 回调。
  useEffect(() => {
    const listEl = listRef.current;
    const scrollEl = scrollRef.current;
    if (!listEl || !scrollEl) return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) stickToBottom();
    });
    observer.observe(listEl);
    if (followingRef.current) stickToBottom();
    return () => observer.disconnect();
  }, [scrollRef, stickToBottom]);

  const virtualItems = virtualizer.getVirtualItems();

  // 刷新轮偏移注册表（虚拟化测量 + live tail 位置）
  useEffect(() => {
    for (const vi of virtualItems) {
      const turn = historyTurns[vi.index];
      if (turn) turnOffsetRegistry.set(turn.key, scrollMargin + vi.start);
    }
    if (liveTurn) {
      turnOffsetRegistry.set(liveTurn.key, scrollMargin + virtualizer.getTotalSize());
    }
  }, [virtualItems, historyTurns, liveTurn, scrollMargin, virtualizer]);

  return (
    <div className="message-list" ref={listRef} style={{ overflowAnchor: "none" }}>
      {/* 虚拟化历史轮（全部已完成轮） */}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualItems.map((vi) => {
          const turn = historyTurns[vi.index];
          if (!turn) return null;
          return (
            <div
              key={turn.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start - scrollMargin}px)` }}
            >
              <TurnGroupView
                group={turn}
                liveNowMs={0}
                workspaceRoot={workspaceRoot}
                onEditSend={stableEditSend}
                onEditResend={stableEditResend}
                onStartEdit={handleStartEdit}
                onCancelEdit={handleCancelEdit}
                onRetryFrom={stableRetryFrom}
                onBranchFrom={stableBranchFrom}
                isEditing={editingMessageKey === turn.userMessage?.id}
                actionsDisabled={isStreaming}
                streaming={false}
                highlightMessageId={highlightMessageId}
              />
            </div>
          );
        })}
      </div>
      {/* live tail：正在流式的最后一轮放普通文档流（不进虚拟列表，消除长高回填跳动） */}
      {liveTurn ? (
        <>
          <TurnGroupView
            group={liveTurn}
            live
            liveNowMs={liveNowMs}
            hiddenSpans={hiddenSpansRef.current}
            pendingApproval={pendingApproval}
            retryAttempts={retryAttempts}
            retrying={retrying}
            workspaceRoot={workspaceRoot}
            onEditSend={stableEditSend}
            onEditResend={stableEditResend}
            onStartEdit={handleStartEdit}
            onCancelEdit={handleCancelEdit}
            onRetryFrom={stableRetryFrom}
            onBranchFrom={stableBranchFrom}
            isEditing={editingMessageKey === liveTurn.userMessage?.id}
            actionsDisabled={isStreaming}
            streaming
            highlightMessageId={highlightMessageId}
          />
          <div ref={endRef} />
        </>
      ) : (
        <div ref={endRef} />
      )}
    </div>
  );
}
