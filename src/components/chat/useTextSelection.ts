/**
 * useTextSelection —— 选区监听（P2-C1，LA/ZCode useTextSelection 简化适配）。
 *
 * - mouseup/touchend 为主触发（rAF 后一次性检查选区）；selectionchange 只做
 *   「折叠即关闭」；
 * - 任何滚动（capture 捕获子元素滚动）/Escape/窗口 resize 一律关闭
 *   （对齐 ZCode：浮层不跟随滚动）；
 * - 返回非折叠选区文本与浮层锚点坐标（选区首末 rect 包络）。
 */

import { useEffect, useState } from "react";

export interface SelectionState {
  text: string;
  /** 浮层锚点：选区包络矩形（viewport 坐标）。 */
  rect: { top: number; bottom: number; left: number; right: number };
}

export function useTextSelection(scrollEl: HTMLElement | null, enabled: boolean) {
  const [selection, setSelection] = useState<SelectionState | null>(null);

  useEffect(() => {
    // ⚠️ 依赖 scrollEl（state）而非自行查询：viewport 后挂载（任务打开）时
    // 自行查询会在 mount 时拿到 null 且永不重挂（实测踩过）。
    if (!scrollEl) return;
    const root = scrollEl;
    if (!enabled) {
      setSelection(null);
      return;
    }

    let rafId: number | null = null;

    const inspect = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      // 选区必须落在 root 内
      if (!root.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }
      const text = sel.toString();
      if (!text.trim()) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSelection(null);
        return;
      }
      setSelection({
        text,
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      });
    };

    const schedule = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(inspect);
    };
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setSelection(null);
    };
    const close = () => setSelection(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    root.addEventListener("mouseup", schedule);
    root.addEventListener("touchend", schedule);
    document.addEventListener("keyup", onKeyDown);
    document.addEventListener("selectionchange", onSelectionChange);
    // 任何滚动（含子元素滚动 capture）关闭——浮层不跟随滚动（对齐 ZCode）
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      root.removeEventListener("mouseup", schedule);
      root.removeEventListener("touchend", schedule);
      document.removeEventListener("keyup", onKeyDown);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      setSelection(null);
    };
  }, [scrollEl, enabled]);

  return selection;
}
