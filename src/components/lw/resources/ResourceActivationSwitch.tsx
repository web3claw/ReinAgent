// LiveAgent 移植：crates/agent-ui/src/components/resources/ResourceActivationSwitch.tsx
// 适配：Base UI SwitchRoot 的 render/nativeButton/inputRef 不再需要 ——
// lw/ui/switch 的 SwitchRoot 本身就是原生 button（资源卡片内的点击冒泡
// 通过事件边界 span 处理，语义与 LA 保持一致）。
import { type Ref, type SyntheticEvent, useRef } from "react";

import { cn } from "../lib/utils";
import { SwitchRoot, SwitchThumb } from "../ui/switch";

export function ResourceActivationSwitch(props: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  compact?: boolean;
  stopPropagation?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const compact = props.compact === true;
  const stopEventPropagation = (event: SyntheticEvent) => {
    if (props.stopPropagation) event.stopPropagation();
  };

  return (
    // 可见按钮的点击策略保留在 SwitchRoot 上；键盘激活由 role="switch" 的
    // 原生按钮承接（空格/回车），与 LA 的原生 input 行为一致。
    <span
      className="contents"
      onClick={(event) => {
        if (event.target === inputRef.current) event.stopPropagation();
      }}
    >
      <SwitchRoot
        ref={inputRef as unknown as Ref<HTMLButtonElement>}
        checked={props.checked}
        aria-label={props.label}
        title={props.label}
        disabled={props.disabled}
        onPointerDown={stopEventPropagation}
        onMouseDown={stopEventPropagation}
        onClick={(event) => {
          stopEventPropagation(event);
        }}
        onCheckedChange={props.onCheckedChange}
        onKeyDown={stopEventPropagation}
        className={cn(
          "relative inline-flex shrink-0 items-center rounded-full ring-1 ring-border/40 transition-all",
          "disabled:cursor-not-allowed disabled:opacity-45",
          compact ? "h-5 w-9" : "h-6 w-11",
          props.checked ? "bg-sky-500 dark:bg-sky-400" : "bg-muted-foreground/25",
        )}
      >
        <SwitchThumb
          className={cn(
            "pointer-events-none inline-block rounded-full bg-white shadow-sm transition-transform",
            compact ? "size-3.5" : "size-18px",
            props.checked
              ? compact
                ? "translate-x-4.75"
                : "translate-x-23px"
              : compact
                ? "translate-x-0.75"
                : "translate-x-3px",
          )}
        />
      </SwitchRoot>
    </span>
  );
}
