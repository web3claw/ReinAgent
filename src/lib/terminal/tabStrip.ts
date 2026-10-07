/**
 * tabStrip.ts —— 终端 tab 条纯逻辑（LiveAgent RightDockTabStrip/useRightDockTabReorder
 * 语义的精简移植：坞内拖动重排 + 关闭走二次确认）。
 *
 * 纯函数，无 DOM 依赖，供 TerminalPane 与单测共用。
 */

export interface TerminalTabLike {
  id: string;
}

/**
 * 拖动重排：把 draggedId 移到 targetIndex 槽位（目标序号按**拖动前**的数组计）。
 * 语义 = 拖到哪个槽位就落在那个位置：先摘出再插入同序号位置，
 * 因此 [A,B,C,D] 拖 A 到槽 2 → [B,C,A,D]（A 占据 C 原视觉位），
 * 拖 D 到槽 1 → [A,D,B,C]。无变化/未知 id/越界时返回原引用（供 React 跳过更新）。
 */
export function moveTabToIndex<T extends TerminalTabLike>(
  tabs: readonly T[],
  draggedId: string,
  targetIndex: number,
): readonly T[] {
  const from = tabs.findIndex((tab) => tab.id === draggedId);
  if (from < 0 || tabs.length <= 1) return tabs;
  const target = Math.max(0, Math.min(tabs.length - 1, targetIndex));
  if (from === target) return tabs;
  const next = tabs.slice();
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/** 指针 x 落在哪个槽位的序号（以槽位左右边为界；左侧超出 = 0，右侧超出 = 末位）。 */
export function tabIndexAtX(
  slots: readonly { id: string; left: number; right: number }[],
  x: number,
): number {
  if (slots.length === 0) return -1;
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    if (x >= slot.left && x <= slot.right) return i;
  }
  return x < slots[0].left ? 0 : slots.length - 1;
}

export type TabCloseDecision = "confirm" | "direct";

/**
 * 关闭 tab 的决策（对齐 LiveAgent「关闭正在运行的终端要确认」语义）：
 * - 关闭的是**活动 tab 且会话存活**（会话只挂在活动 tab 上，切换即重建）→ 需二次确认；
 * - 非活动 tab 没有存活会话、或会话已断开（error/connecting 不弹）→ 直接关。
 */
export function decideTabClose(params: {
  activeTabId: string;
  closingTabId: string;
  sessionAlive: boolean;
}): TabCloseDecision {
  const { activeTabId, closingTabId, sessionAlive } = params;
  return closingTabId === activeTabId && sessionAlive ? "confirm" : "direct";
}
