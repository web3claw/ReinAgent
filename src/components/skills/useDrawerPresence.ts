// LiveAgent 移植：<crates/agent-ui/src/pages/skills-hub/useDrawerPresence.ts>
// 适配：lw/ui/sheet 已从 Base UI Dialog 改为 Radix Dialog，无 onOpenChangeComplete
// 回调。改为钩子内自管理：
// - entered：open 翻 true 后的首帧置位（Radix 入场动画由 data-[state=open] 驱动，
//   调用方在 entered 前用骨架屏顶替重内容，避免动画期掉帧，语义与 LA 一致）；
// - 快照释放：关闭后父级立刻清空内容，这里保留最后一份快照渲染完退场动画
//   （Radix Presence 在退场动画播完前不卸载 Content，动画时长 200ms + 余量）再释放。
import { startTransition, useEffect, useRef, useState } from "react";

const DRAWER_EXIT_ANIMATION_MS = 220;

export function useDrawerPresence<T>(current: T | null): {
  open: boolean;
  snapshot: T | null;
  entered: boolean;
} {
  const open = current !== null;
  const retainedRef = useRef<T | null>(null);
  if (current !== null) {
    retainedRef.current = current;
  }
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!open) {
      const timer = window.setTimeout(() => {
        retainedRef.current = null;
        setEntered(false);
      }, DRAWER_EXIT_ANIMATION_MS);
      return () => window.clearTimeout(timer);
    }
    const raf = requestAnimationFrame(() => startTransition(() => setEntered(true)));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  return {
    open,
    snapshot: current ?? retainedRef.current,
    entered,
  };
}
