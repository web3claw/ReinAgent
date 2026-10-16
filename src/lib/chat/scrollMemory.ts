export interface ScrollAnchor {
  mid: string;
  off: number;
}

export interface ScrollMemoryEntry {
  wasPinnedToBottom: boolean;
  anchor?: ScrollAnchor;
}

export type ScrollRestoreAction =
  | { type: "stick_bottom" }
  | { type: "restore_anchor"; anchor: ScrollAnchor };

/**
 * 计算保存的滚动记忆状态（对齐 ZCode chatSessionScrollMemory 规范）：
 * - 若处于贴底跟随 (isFollowing) 或视口距离底部 <= threshold (默认 80px)，
 *   必须标记 wasPinnedToBottom: true；
 * - 仅当用户主动向上翻阅历史消息时，才记录 topMsgId + 相对偏移作为锚点。
 */
export function computeScrollMemoryState(params: {
  isFollowing: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  threshold?: number;
  topMsgId?: string | null;
  topMsgOffset?: number;
}): ScrollMemoryEntry | null {
  const threshold = params.threshold ?? 80;
  const isAtBottom =
    params.isFollowing ||
    params.scrollHeight - params.scrollTop - params.clientHeight <= threshold;

  if (isAtBottom) {
    return { wasPinnedToBottom: true };
  }

  if (params.topMsgId) {
    return {
      wasPinnedToBottom: false,
      anchor: {
        mid: params.topMsgId,
        off: params.topMsgOffset ?? 0,
      },
    };
  }

  return null;
}

/**
 * 解析切回会话时的滚动恢复行为：
 * 1. 若当前会话任务处于活跃运行状态 (hasLiveTurn / isStreaming)，必须贴底跟随 (stick_bottom)，绝不跳回上方；
 * 2. 若此前离开会话时处于贴底状态 (wasPinnedToBottom === true) 或无历史记忆，保持贴底 (stick_bottom)；
 * 3. 仅当用户离开前在阅读上方历史 (wasPinnedToBottom === false) 且会话非运行态时，精准恢复历史锚点 (restore_anchor)。
 */
export function resolveScrollRestoreAction(params: {
  saved?: ScrollMemoryEntry | null;
  hasLiveTurn: boolean;
}): ScrollRestoreAction {
  if (params.hasLiveTurn) {
    return { type: "stick_bottom" };
  }

  if (!params.saved || params.saved.wasPinnedToBottom) {
    return { type: "stick_bottom" };
  }

  if (params.saved.anchor && params.saved.anchor.mid) {
    return { type: "restore_anchor", anchor: params.saved.anchor };
  }

  return { type: "stick_bottom" };
}
