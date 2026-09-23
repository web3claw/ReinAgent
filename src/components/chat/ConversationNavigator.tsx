/**
 * ConversationNavigator —— 对话问题导航条（对齐 ZCode ConversationTurnNavigator）。
 *
 * - 覆盖式绝对定位：浮于消息滚动区左缘（由父级 relative 容器承载），不占布局空间；
 * - 每条用户提问一枚刻度；悬停 Radix Tooltip 弹出「用户提问 + 助手回复」双段预览；
 * - 点击刻度手动计算 scrollTop 平滑跳转（跳离底部后 MessageList 现有贴底跟随自然解除）；
 * - active 高亮：scroll 事件 + 锚点内容坐标几何计算（rAF 节流），无 IntersectionObserver；
 * - 悬停时邻近刻度呈山峰状衰减放大（resolvePeakVisual），prefers-reduced-motion 兼容；
 * - 显隐：用户提问 < 2 条或容器宽 < 864px 时整体隐藏。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { TimelineEntry } from "../../lib/chat/conversationModel";
import {
  buildNavigatorItems,
  resolveNavigatorLayout,
  resolveActiveAnchor,
  resolvePeakVisual,
  NAVIGATOR_MIN_VISIBLE_WIDTH,
  NAVIGATOR_MIN_ITEMS,
} from "../../lib/chat/conversationNavigatorHelpers";
import { useTranslation } from "../../i18n";

/** 导航条与容器上 / 下边的呼吸留白（下部额外避让吸底输入胶囊） */
const RAIL_TOP_INSET = 48;
const RAIL_BOTTOM_INSET = 96;
/** 跳转定位时目标行与视口顶的呼吸间距 */
const JUMP_TOP_GAP = 16;

export interface ConversationNavigatorProps {
  messages: TimelineEntry[];
  /** 消息滚动容器 ref（App.tsx 中 hasMessages 分支的滚动元素） */
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

export function ConversationNavigator({ messages, scrollRef }: ConversationNavigatorProps) {
  const { t } = useTranslation();
  const items = useMemo(() => buildNavigatorItems(messages), [messages]);

  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const offsetsRef = useRef<number[]>([]);
  const rafRef = useRef(0);

  // 容器尺寸观察：宽度决定显隐，高度决定自适应布局
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainerSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    setContainerSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, [scrollRef]);

  const layout = useMemo(
    () =>
      resolveNavigatorLayout(
        items.length,
        containerSize.height - RAIL_TOP_INSET - RAIL_BOTTOM_INSET
      ),
    [items.length, containerSize.height]
  );

  // 测量各刻度锚点的内容坐标（相对滚动容器顶部）
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el || items.length === 0) {
      offsetsRef.current = [];
      return;
    }
    const containerTop = el.getBoundingClientRect().top;
    offsetsRef.current = items.map((item) => {
      const node = el.querySelector(`[data-msg-id="${CSS.escape(item.msgId)}"]`);
      if (!node) return -1;
      return (node as HTMLElement).getBoundingClientRect().top - containerTop + el.scrollTop;
    });
    setActiveIndex((cur) => {
      const next = resolveActiveAnchor(offsetsRef.current, el.scrollTop, el.clientHeight);
      return next === cur ? cur : next;
    });
  }, [items, scrollRef]);

  const syncActive = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      const next = resolveActiveAnchor(offsetsRef.current, el.scrollTop, el.clientHeight);
      setActiveIndex((cur) => (next === cur ? cur : next));
    });
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", syncActive, { passive: true });
    return () => {
      el.removeEventListener("scroll", syncActive);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [measure, syncActive, scrollRef]);

  const handleClick = useCallback(
    (msgId: string) => {
      const el = scrollRef.current;
      if (!el) return;
      const node = el.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
      if (!node) return;
      const target =
        el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top - JUMP_TOP_GAP;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollTo({ top: Math.max(0, target), behavior: reduced ? "auto" : "smooth" });
    },
    [scrollRef]
  );

  if (items.length < NAVIGATOR_MIN_ITEMS || containerSize.width < NAVIGATOR_MIN_VISIBLE_WIDTH) {
    return null;
  }

  const jumpTemplate = t("turnNavigatorJump");

  return (
    <TooltipPrimitive.Provider delayDuration={120}>
      <div
        className="absolute left-0 z-10 w-12 pointer-events-none"
        style={{ top: RAIL_TOP_INSET, bottom: RAIL_BOTTOM_INSET }}
        role="navigation"
        aria-label={t("turnNavigatorLabel")}
      >
      <div
        className={`navigator-rail absolute left-3 top-1/2 -translate-y-1/2 w-9 overflow-y-auto overflow-x-hidden pointer-events-auto ${
          layout.scrollable ? "" : "flex flex-col justify-center"
        }`}
        style={{ height: layout.railHeight, maxHeight: "100%" }}
      >
        {items.map((item, i) => {
          const distance = hoveredIndex === null ? null : i - hoveredIndex;
          const visual =
            distance === null
              ? i === activeIndex
                ? { scaleX: 1, opacity: 0.9 }
                : { scaleX: 1, opacity: 0.35 }
              : resolvePeakVisual(distance);
          const isActive = i === activeIndex;
          return (
            <TooltipPrimitive.Root key={item.msgId} delayDuration={120}>
              <TooltipPrimitive.Trigger asChild>
                <button
                  type="button"
                  onClick={() => handleClick(item.msgId)}
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex((cur) => (cur === i ? null : cur))}
                  onFocus={() => setHoveredIndex(i)}
                  onBlur={() => setHoveredIndex((cur) => (cur === i ? null : cur))}
                  aria-label={jumpTemplate.replace("{index}", String(i + 1))}
                  aria-current={isActive ? "location" : undefined}
                  aria-posinset={i + 1}
                  aria-setsize={items.length}
                  className="flex items-center w-full outline-none cursor-pointer"
                  style={{ height: layout.slot }}
                >
                  <span
                    className={`block h-0.5 w-3 origin-left rounded-full transition-transform duration-150 motion-reduce:transition-none ${
                      isActive || distance !== null ? "bg-[var(--text)]" : "bg-[var(--text-dim)]"
                    }`}
                    style={{ transform: `scaleX(${visual.scaleX})`, opacity: visual.opacity }}
                  />
                </button>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content
                  side="right"
                  align="start"
                  sideOffset={8}
                  className="z-50 w-80 max-w-[calc(100vw-2rem)] bg-[var(--bg-elev)] border border-[var(--border)] rounded-xl p-3 shadow-xl animate-in fade-in-0 zoom-in-95 select-none"
                >
                  <p className="text-xs font-medium text-[var(--text)] line-clamp-2 whitespace-pre-line">
                    {item.userPreview || "…"}
                  </p>
                  <p className="mt-1.5 text-xs text-[var(--text-secondary)] line-clamp-3 whitespace-pre-line">
                    {item.assistantRunning
                      ? t("turnNavigatorRunning")
                      : item.assistantPreview || t("turnNavigatorEmptyReply")}
                  </p>
                  <TooltipPrimitive.Arrow className="fill-[var(--bg-elev)]" />
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
          );
        })}
        </div>
      </div>
    </TooltipPrimitive.Provider>
  );
}
