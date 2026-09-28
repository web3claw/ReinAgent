/**
 * useChatScrollState —— 聊天滚动容器的「离底状态」感知（P2-A2）。
 *
 * 输出：
 * - awayFromBottom：滚动位置离开底部超过阈值（回顶按钮显示条件 + 输入区 dock
 *   分离感【顶部边框/阴影】的条件）；
 * - scrollToTop / scrollToBottom：平滑滚动入口。
 *
 * 监听挂在 scrollEl（App 的 chatScrollEl state，MessageList 挂载后才有），
 * scrollEl 变化自动重挂。
 */

import { useEffect, useState } from "react";

/** 离底超过该像素数视为「已离开底部」。 */
const AWAY_FROM_BOTTOM_PX = 120;

export function useChatScrollState(scrollEl: HTMLElement | null) {
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  useEffect(() => {
    // ⚠️ 依赖 scrollEl（state）而非 ref：ref 回调时序上晚于 effect，
    // 用 ref 会让监听在首次挂载时静默跳过且永不重挂（实测踩过）。
    if (!scrollEl) return;
    const onScroll = () => {
      const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
      setAwayFromBottom(distance > AWAY_FROM_BOTTOM_PX);
    };
    onScroll();
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    // ⚠️ 内容水合/流式增长不触发 scroll 事件——ResizeObserver 监听容器与
    // 首个子元素的尺寸变化重算（否则初始空内容判定 false 后永不更新，实测踩过）。
    const observer = new ResizeObserver(onScroll);
    observer.observe(scrollEl);
    if (scrollEl.firstElementChild) observer.observe(scrollEl.firstElementChild);
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [scrollEl]);

  const scrollToTop = () => {
    scrollEl?.scrollTo({ top: 0, behavior: "smooth" });
  };
  const scrollToBottom = () => {
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  };

  return { awayFromBottom, scrollToTop, scrollToBottom };
}
