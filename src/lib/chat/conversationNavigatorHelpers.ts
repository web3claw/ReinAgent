/**
 * conversationNavigatorHelpers.ts —— 对话问题导航条（对齐 ZCode ConversationTurnNavigator）
 * 的纯逻辑层：刻度构建 / 预览截断 / 自适应布局 / active 几何判定 / 山峰衰减视觉。
 *
 * 设计要点（已确认规格）：
 * - 刻度粒度为「每条用户提问」一根，助手回复与工具调用不产生刻度；
 * - 导航条默认初始高度 240px，节点间距随数量在 [10, 24] 内自适应，
 *   最小间距 10px 与 ZCode 刻度槽位（h-2.5 = 10px）一致；超出容量进入内部滚动；
 * - 预览截断对齐 ZCode：220 字符 / 2 段上限，段内空白折叠，超长 slice + "..."；
 * - active 判定不使用 IntersectionObserver：基于锚点内容坐标 + 视口的几何计算，
 *   取「与视口相交且最靠近视口顶」的刻度，无相交时回退「视口顶上方最近一条」。
 */

import type { TimelineEntry } from "./conversationModel";

// ---- 布局常量（已确认规格）----
/** 导航条默认初始高度（px）：刻度很少时保持稳定存在感 */
export const NAVIGATOR_DEFAULT_RAIL_HEIGHT = 240;
/** 刻度槽位最大间距（px）：刻度少时按此封顶，避免荒诞拉满 */
export const NAVIGATOR_MAX_SLOT = 24;
/** 刻度槽位最小间距（px）：与 ZCode 刻度槽位 h-2.5 = 10px 完全一致（密度地板） */
export const NAVIGATOR_MIN_SLOT = 10;
/** 导航条显示的最小容器宽度（px），对齐 ZCode */
export const NAVIGATOR_MIN_VISIBLE_WIDTH = 864;
/** 刻度少于此数时整个隐藏，对齐 ZCode */
export const NAVIGATOR_MIN_ITEMS = 2;

// ---- 预览截断常量（对齐 ZCode）----
export const PREVIEW_MAX_CHARS = 220;
export const PREVIEW_MAX_PARAGRAPHS = 2;

/** 一枚刻度的数据：用户消息锚点 + 双侧预览 */
export interface NavigatorItem {
  /** 用户消息 id —— MessageList 侧 DOM 锚点（data-msg-id） */
  msgId: string;
  /** 用户消息预览（已按 220 字符 / 2 段截断） */
  userPreview: string;
  /** 其后第一条助手回复预览；空串表示尚无回复 */
  assistantPreview: string;
  /** 助手回复是否正在流式生成中（预览降级为「生成中…」） */
  assistantRunning: boolean;
}

/**
 * 预览文本截断（对齐 ZCode 规则）：
 * 按空行切段 -> 段内空白折叠为单空格 -> 取前 maxParagraphs 段以换行连接 ->
 * 超过 maxChars 时 slice(0, maxChars - 3).trimEnd() + "..."。纯文本处理，不渲染 Markdown。
 */
export function truncatePreview(
  raw: string,
  maxChars: number = PREVIEW_MAX_CHARS,
  maxParagraphs: number = PREVIEW_MAX_PARAGRAPHS
): string {
  if (!raw) return "";
  const blocks = raw.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const paragraphs: string[] = [];
  for (const block of blocks) {
    const collapsed = block.replace(/\s+/g, " ").trim();
    if (collapsed) paragraphs.push(collapsed);
    if (paragraphs.length >= maxParagraphs) break;
  }
  const joined = paragraphs.join("\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars - 3).trimEnd() + "...";
}

/**
 * 从时间线构建刻度项：每条 role === "user" 一枚；
 * 助手预览取该提问之后、下一条用户消息之前的首条 assistant 文本。
 */
export function buildNavigatorItems(messages: TimelineEntry[]): NavigatorItem[] {
  const items: NavigatorItem[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    let assistantPreview = "";
    let assistantRunning = false;
    for (let j = i + 1; j < messages.length; j++) {
      const n = messages[j];
      if (n.role === "user") break;
      if (n.role === "assistant") {
        assistantPreview = truncatePreview(n.text);
        assistantRunning = n.status === "streaming";
        break;
      }
    }
    items.push({
      msgId: m.id,
      userPreview: truncatePreview(m.text),
      assistantPreview,
      assistantRunning,
    });
  }
  return items;
}

/** 导航条自适应布局结果 */
export interface NavigatorLayout {
  /** 每枚刻度的槽位高度（px） */
  slot: number;
  /** 导航条总高度（px）：默认 240，容器不足时封顶为容器可用高度 */
  railHeight: number;
  /** 刻度总内容超出导航条高度，需内部滚动 */
  scrollable: boolean;
}

/**
 * 自适应布局（已确认规格）：
 * 目标高度 = min(240, 容器可用高度)；槽位 = 目标高度 / 刻度数，钳制在 [10, 24]；
 * 当 刻度数 × 10 > 目标高度 时锁定 10px 并进入内部滚动。
 */
export function resolveNavigatorLayout(itemCount: number, availableHeight: number): NavigatorLayout {
  if (itemCount <= 0) return { slot: 0, railHeight: 0, scrollable: false };
  const cap = availableHeight > 0 ? availableHeight : NAVIGATOR_DEFAULT_RAIL_HEIGHT;
  const targetHeight = Math.min(NAVIGATOR_DEFAULT_RAIL_HEIGHT, cap);
  const raw = targetHeight / itemCount;
  const slot = Math.min(NAVIGATOR_MAX_SLOT, Math.max(NAVIGATOR_MIN_SLOT, raw));
  const content = itemCount * slot;
  const scrollable = content > targetHeight + 0.5;
  return { slot, railHeight: targetHeight, scrollable };
}

/**
 * active 刻度几何判定（对齐 ZCode，无 IntersectionObserver）：
 * starts 为各刻度锚点的内容坐标（相对滚动容器顶部，升序）；
 * 刻度行范围视为 [start_i, start_{i+1})，取首个与视口 [scrollTop, scrollTop + viewportHeight)
 * 相交的刻度；无相交时回退「视口顶上方最近一条」（nearestAbove）。
 */
export function resolveActiveAnchor(starts: number[], scrollTop: number, viewportHeight: number): number {
  if (starts.length === 0) return -1;
  const viewportBottom = scrollTop + viewportHeight;
  for (let i = 0; i < starts.length; i++) {
    const rowStart = starts[i];
    const rowEnd = i + 1 < starts.length ? starts[i + 1] : Number.POSITIVE_INFINITY;
    if (rowEnd > scrollTop && rowStart < viewportBottom) return i;
  }
  let nearestAbove = -1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= scrollTop + 1) nearestAbove = i; else break;
  }
  return nearestAbove;
}

/** 悬停山峰衰减视觉：|距离| -> [scaleX, opacity]，对齐 ZCode 参数（2.6/1.7/1.25 衰减） */
const PEAK_VISUAL: Array<{ scaleX: number; opacity: number }> = [
  { scaleX: 2.6, opacity: 1 },
  { scaleX: 1.7, opacity: 0.86 },
  { scaleX: 1.25, opacity: 0.72 },
];

export function resolvePeakVisual(distance: number): { scaleX: number; opacity: number } {
  const d = Math.abs(distance);
  if (d < PEAK_VISUAL.length) return PEAK_VISUAL[d];
  return { scaleX: 1, opacity: 0.58 };
}
